package gitstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/jimyag/gitwiki/internal/auth"
)

// Prepare every changed file before writing: malformed comments and destination collisions
// must fail without moving any page. All durable changes belong to the same Git commit.
func (r *Repo) movePageLocked(ctx context.Context, from, to, parent string, u *auth.User) (newID string, updated int, retErr error) {
	for _, rel := range []string{from, to} {
		if err := r.checkMovePath(rel); err != nil {
			return "", 0, err
		}
	}
	root := filepath.Clean(filepath.Join(r.cfg.Workdir, r.cfg.ContentDir))
	if _, _, err := r.diskPath(from); err != nil {
		return "", 0, err
	}
	dst, err := r.resolvePath(to)
	if err != nil {
		return "", 0, err
	}
	for _, p := range []string{dst, dst + ".md"} {
		if _, err := os.Lstat(p); err == nil {
			return "", 0, ErrExists
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", 0, err
		}
	}
	changes := map[string][]byte{} // nil deletes a file; all paths are relative to content_dir
	content, err := os.OpenRoot(root)
	if err != nil {
		return "", 0, err
	}
	defer func() {
		if content != nil {
			retErr = errors.Join(retErr, content.Close())
		}
	}()
	readContent := func(rel string) ([]byte, error) {
		f, err := content.Open(filepath.FromSlash(rel))
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(f)
		return data, errors.Join(readErr, f.Close())
	}
	promoteParent := false
	if parent != "" {
		_, bundle, err := r.diskPath(parent)
		switch {
		case errors.Is(err, ErrNotFound):
			dir, err := r.resolvePath(parent)
			if err != nil {
				return "", 0, err
			}
			st, err := os.Stat(dir)
			if err != nil || !st.IsDir() {
				return "", 0, ErrNotFound
			}
		case err != nil:
			return "", 0, err
		case !bundle:
			promoteParent = true
			data, err := readContent(parent + ".md")
			if err != nil {
				return "", 0, err
			}
			changes[parent+".md"] = nil
			changes[parent+"/_index.md"] = data
		}
	}
	n := 0
	err = filepath.WalkDir(root, func(abs string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if de.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		newRel := rel
		if rel == from+".md" || within(rel, from) {
			newRel = to + strings.TrimPrefix(rel, from)
		}
		commentID, comment := strings.CutPrefix(rel, ".comments/")
		if comment {
			if !strings.HasSuffix(rel, ".json") {
				return nil
			}
			commentID = strings.TrimSuffix(commentID, ".json")
			if within(commentID, from) {
				newRel = ".comments/" + to + strings.TrimPrefix(commentID, from) + ".json"
			}
		}
		page := strings.HasSuffix(rel, ".md") && !comment && !strings.Contains("/"+rel, "/assets/") && !strings.HasPrefix(rel, ".")
		if rel == newRel && !page {
			return nil
		}
		if de.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot move or rewrite symlink: %s", rel)
		}
		data, err := readContent(rel)
		if err != nil {
			return err
		}
		if comment {
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(data, &doc); err != nil {
				return fmt.Errorf("comments %s: %w", rel, err)
			}
			if doc == nil {
				return fmt.Errorf("comments %s: expected object", rel)
			}
			doc["page"], err = json.Marshal(to + strings.TrimPrefix(commentID, from))
			if err != nil {
				return err
			}
			data, err = json.Marshal(doc)
			if err != nil {
				return err
			}
		}
		if page {
			// A destination parent promoted to a bundle also changes its relative-link base.
			if _, promoted := changes[rel]; promoted {
				newRel = parent + "/_index.md"
			}
			out, changed := rewritePageReferences(string(data), rel, newRel, from, to)
			doc, _ := ParsePage([]byte(out))
			if target := MetaOf(doc.FrontMatter).ReplacedBy; target != "" && within(target, from) {
				doc.FrontMatter["replaced_by"] = to + strings.TrimPrefix(target, from)
				rendered, err := RenderPage(doc)
				if err != nil {
					return err
				}
				out, changed = string(rendered), true
			}
			if promoteParent {
				var promotedLink bool
				out, promotedLink = rewritePageReferences(out, newRel, newRel, parent+".md", parent+"/_index.md")
				changed = changed || promotedLink
			}
			if changed {
				data = []byte(out)
				n++
			} else if rel == newRel {
				return nil
			}
		}
		if newRel != rel {
			newAbs, err := r.resolvePath(newRel)
			if err != nil {
				return err
			}
			if _, err := os.Lstat(newAbs); err == nil {
				return fmt.Errorf("%w: %s", ErrExists, newRel)
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}
			changes[rel] = nil
		}
		changes[newRel] = data
		return nil
	})
	err = errors.Join(err, content.Close())
	content = nil
	if err != nil {
		return "", 0, err
	}
	if err := r.commitMove(ctx, changes, from, to, u); err != nil {
		return "", 0, err
	}
	r.schedulePush(u.Token)
	return to, n, nil
}

// Save the touched files and index so write/stage/commit failures can restore this operation
// without resetting unrelated work. Existing edits in a touched file are never overwritten.
func (r *Repo) commitMove(ctx context.Context, changes map[string][]byte, from, to string, u *auth.User) (retErr error) {
	paths := make([]string, 0, len(changes))
	for rel := range changes {
		if err := r.checkMovePath(rel); err != nil {
			return err
		}
		paths = append(paths, r.gitPath(rel))
	}
	slices.Sort(paths)
	status, err := r.gitOut(ctx, append([]string{"status", "--porcelain", "--untracked-files=all", "--"}, paths...)...)
	if err != nil {
		return err
	}
	if len(status) != 0 {
		return fmt.Errorf("%w: 移动涉及的文件有未提交修改，请先处理", ErrConflict)
	}
	indexPath, err := r.gitOut(ctx, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return err
	}
	index := strings.TrimSpace(string(indexPath))
	indexData, err := os.ReadFile(index) // #nosec G304 -- Git resolves its own index path in the configured repository.
	if err != nil {
		return err
	}
	type snapshot struct {
		data   []byte
		mode   fs.FileMode
		exists bool
	}
	before := map[string]snapshot{}
	for _, p := range paths {
		abs := filepath.Join(r.cfg.Workdir, filepath.FromSlash(p))
		st, err := os.Lstat(abs)
		if errors.Is(err, os.ErrNotExist) {
			before[abs] = snapshot{}
			continue
		}
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return fmt.Errorf("not a regular file: %s", p)
		}
		data, err := os.ReadFile(abs) // #nosec G304 -- change paths were validated by resolvePath; only regular files are read.
		if err != nil {
			return err
		}
		before[abs] = snapshot{data: data, mode: st.Mode().Perm(), exists: true}
	}
	defer func() {
		if retErr == nil {
			return
		}
		for abs, s := range before {
			if s.exists {
				if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
					retErr = errors.Join(retErr, err)
					continue
				}
				retErr = errors.Join(retErr, os.WriteFile(abs, s.data, s.mode))
			} else if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
				retErr = errors.Join(retErr, err)
			}
		}
		retErr = errors.Join(retErr, os.WriteFile(index, indexData, 0o600)) // #nosec G703 -- index is Git's own path in the configured repository, not request input.
		for abs, s := range before {
			if !s.exists {
				retErr = errors.Join(retErr, r.removeEmptyParents(abs))
			}
		}
	}()
	for rel, data := range changes {
		abs, err := r.resolvePath(rel)
		if err != nil {
			return err
		}
		if data == nil {
			if err := os.Remove(abs); err != nil {
				return err
			}
		} else {
			if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
				return err
			}
			mode := before[abs].mode
			if mode == 0 {
				mode = 0o644
			}
			if err := os.WriteFile(abs, data, mode); err != nil {
				return err
			}
		}
	}
	for rel, data := range changes {
		if data == nil {
			if err := r.removeEmptyParents(filepath.Join(r.cfg.Workdir, r.gitPath(rel))); err != nil {
				return err
			}
		}
	}
	if err := r.git(ctx, append([]string{"add", "-A", "--"}, paths...)...); err != nil {
		return err
	}
	// --only leaves unrelated staged changes out of the move commit.
	return r.commitAs(ctx, u, fmt.Sprintf("wiki: move %s → %s", from, to), paths...)
}

func (r *Repo) checkMovePath(rel string) error {
	abs, err := r.resolvePath(rel)
	if err != nil {
		return err
	}
	root := filepath.Clean(filepath.Join(r.cfg.Workdir, r.cfg.ContentDir))
	for p := abs; p != root && strings.HasPrefix(p, root+string(filepath.Separator)); p = filepath.Dir(p) {
		st, err := os.Lstat(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symlink at %s", ErrBadPath, rel)
		}
	}
	return nil
}

func (r *Repo) removeEmptyParents(file string) error {
	root := filepath.Clean(filepath.Join(r.cfg.Workdir, r.cfg.ContentDir))
	for dir := filepath.Dir(file); dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)); dir = filepath.Dir(dir) {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			break
		}
		if err := os.Remove(dir); err != nil {
			return err
		}
	}
	return nil
}
