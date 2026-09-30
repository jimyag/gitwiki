package gitstore

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jimyag/gitwiki/internal/auth"
)

// Page abstracts a Hugo content page. Two physical forms:
//   - leaf:   content/<id>.md
//   - bundle: content/<id>/_index.md, can have children and page-attached assets
// Page operations automatically migrate between forms.
type Page struct {
	ID      string  `json:"id"`       // e.g. "guide/install" - slash-separated, no extension
	Title   string  `json:"title"`    // last segment
	IsDir   bool    `json:"is_dir"`   // bundle form (or virtual: has children)
	HasBody bool    `json:"has_body"` // has backing markdown file
	Children []*Page `json:"children,omitempty"`
}

// ErrNotFound is returned when page content does not exist.
var ErrNotFound = errors.New("page not found")

// diskPath returns the absolute markdown file path for the page id.
// Leaf takes precedence; falls back to bundle index.
func (r *Repo) diskPath(id string) (abs string, isBundle bool, err error) {
	if id == "" {
		return "", false, ErrBadPath
	}
	leaf, err := r.resolvePath(id + ".md")
	if err != nil {
		return "", false, err
	}
	if _, err := os.Stat(leaf); err == nil {
		return leaf, false, nil
	}
	bundle, err := r.resolvePath(filepath.Join(id, "_index.md"))
	if err != nil {
		return "", false, err
	}
	if _, err := os.Stat(bundle); err == nil {
		return bundle, true, nil
	}
	return "", false, ErrNotFound
}

// PageTree returns the hierarchy under content dir as Pages.
// Each directory containing _index.md or .md files becomes a page node.
func (r *Repo) PageTree(ctx context.Context) (*Page, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	root := &Page{ID: "", Title: r.cfg.Title, IsDir: true}
	contentRoot := filepath.Join(r.cfg.Workdir, r.cfg.ContentDir)
	err := filepath.WalkDir(contentRoot, func(path string, de os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable
		}
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			if de.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(contentRoot, path)
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		// Build parent chain
		parts := strings.Split(rel, "/")
		cur := root
		for i, p := range parts {
			last := i == len(parts)-1
			isMD := strings.HasSuffix(p, ".md")
			isIndexMD := p == "_index.md"
			if last && isMD && !isIndexMD {
				id := strings.Join(parts[:len(parts)-1], "/")
				base := strings.TrimSuffix(p, ".md")
				if id != "" {
					id += "/"
				}
				id += base
				cur.Children = append(cur.Children, &Page{ID: id, Title: base, HasBody: true})
				continue
			}
			if last && isIndexMD {
				// _index.md: parent (the dir this file lives in) is a bundle page with body
				if len(parts) == 1 {
					root.HasBody = true
					continue
				}
				continue // handled when descending into dir
			}
			// dir (or non-md file we ignore): descend / create stub dir page
			if de.IsDir() {
				id := strings.Join(parts[:i+1], "/")
				var next *Page
				// If leaf page with same ID exists, need bundle form (but Hugo disallows both); skip
				for _, c := range cur.Children {
					if c.ID == id && c.IsDir {
						next = c
						break
					}
				}
				if next == nil {
					next = &Page{ID: id, Title: p, IsDir: true}
					// _index.md inside makes HasBody true
					if _, err := os.Stat(filepath.Join(path, "_index.md")); err == nil {
						next.HasBody = true
					}
					cur.Children = append(cur.Children, next)
				}
				cur = next
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortTree(root)
	return root, nil
}

func sortTree(p *Page) {
	sort.Slice(p.Children, func(i, j int) bool {
		a, b := p.Children[i], p.Children[j]
		if a.IsDir != b.IsDir {
			return a.IsDir // dirs first
		}
		return a.ID < b.ID
	})
	for _, c := range p.Children {
		sortTree(c)
	}
}

// ReadPage returns the markdown body and base SHA for a page id.
func (r *Repo) ReadPage(ctx context.Context, id string) (*File, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, isBundle, err := r.diskPath(id)
	if err != nil {
		return nil, false, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, false, err
	}
	head, err := r.headSHA(ctx)
	if err != nil {
		return nil, false, err
	}
	return &File{Path: id, Content: string(data), BaseSHA: head}, isBundle, nil
}

// SavePage saves the page body, migrating leaf↔bundle as needed.
// `hasChildren` indicates whether the page needs bundle form after save.
// We don't know future children so this just chooses based on what exists on disk.
func (r *Repo) SavePage(ctx context.Context, id, content, baseSHA, message string, u *auth.User) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, isBundle, err := r.diskPath(id)
	if errors.Is(err, ErrNotFound) {
		// Creating new page. Decide form: leaf by default, bundle if dir with children exists.
		dirPath, _ := r.resolvePath(id)
		if st, statErr := os.Stat(dirPath); statErr == nil && st.IsDir() {
			abs, _ = r.resolvePath(filepath.Join(id, "_index.md"))
			isBundle = true
		} else {
			abs, _ = r.resolvePath(id + ".md")
		}
		// Base SHA doesn't apply to creates; use current HEAD.
		head, herr := r.headSHA(ctx)
		if herr != nil {
			return "", herr
		}
		baseSHA = head
	} else if err != nil {
		return "", err
	}

	if err := r.git(ctx, "fetch", "origin", r.cfg.Branch); err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	localHead, err := r.headSHA(ctx)
	if err != nil {
		return "", err
	}

	if localHead != baseSHA {
		merged, conflict, err := r.merge3(ctx, relToMd(id, isBundle), baseSHA, localHead, content)
		if err != nil {
			return "", err
		}
		if conflict {
			return "", &ConflictError{Path: id, Merged: merged, CurrentSHA: localHead}
		}
		content = merged
		if err := r.git(ctx, "merge", "--ff-only", "origin/"+r.cfg.Branch); err != nil {
			return "", fmt.Errorf("ff: %w", err)
		}
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return "", err
	}
	gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, relToMd(id, isBundle)))
	if err := r.git(ctx, "add", "--", gitPath); err != nil {
		return "", err
	}
	if err := r.git(ctx, "diff", "--cached", "--quiet"); err == nil {
		head, _ := r.headSHA(ctx)
		return head, nil
	}
	if message == "" {
		message = "wiki: update " + id
	}
	name := u.Name
	if name == "" {
		name = u.Login
	}
	email := u.Email
	if email == "" {
		email = u.Login + "@users.noreply.github.com"
	}
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	if err := r.gitEnv(ctx, env, "commit", "-m", message); err != nil {
		return "", err
	}
	sha, err := r.headSHA(ctx)
	if err != nil {
		return "", err
	}
	if err := r.setPushToken(ctx, u.Token); err != nil {
		return sha, err
	}
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return sha, fmt.Errorf("%w: %v", ErrPush, err)
	}
	return sha, nil
}

// CreatePage creates an empty page with front matter. If parentID != "", page is nested.
// Returns the final page ID.
func (r *Repo) CreatePage(ctx context.Context, parentID, slug, title string, u *auth.User) (string, error) {
	if slug == "" || strings.Contains(slug, "/") || strings.Contains(slug, "..") {
		return "", ErrBadPath
	}
	id := slug
	if parentID != "" {
		id = parentID + "/" + slug
	}
	body := fmt.Sprintf("---\ntitle: %q\n---\n\n", title)
	// SavePage handles leaf vs bundle choice.
	sha, err := r.SavePage(ctx, id, body, "", "wiki: new page "+id, u)
	if err != nil {
		return "", err
	}
	_ = sha
	return id, nil
}

// relToMd returns the on-disk markdown path (relative to content dir) for a page id.
func relToMd(id string, isBundle bool) string {
	if isBundle {
		return filepath.ToSlash(filepath.Join(id, "_index.md"))
	}
	return id + ".md"
}

// SaveAsset stores an uploaded file under the page's assets dir and returns the
// markdown reference path. Always uses bundle form for the page (migrates if needed).
// assetPath is the relative markdown path the user should insert (e.g. "assets/foo.png").
func (r *Repo) SaveAsset(ctx context.Context, id string, filename string, body io.Reader, u *auth.User) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Migrate leaf to bundle if needed, since assets must live under the page bundle.
	abs, isBundle, err := r.diskPath(id)
	if errors.Is(err, ErrNotFound) {
		// Create empty bundle root directly.
		bundleAbs, bErr := r.resolvePath(filepath.Join(id, "_index.md"))
		if bErr != nil {
			return "", bErr
		}
		if err := os.MkdirAll(filepath.Dir(bundleAbs), 0o755); err != nil {
			return "", err
		}
		abs = bundleAbs
		isBundle = true
	} else if err != nil {
		return "", err
	}

	if !isBundle {
		// leaf -> bundle migration: mv leaf.md → id/_index.md
		leafAbs := abs
		bundleAbs, bErr := r.resolvePath(filepath.Join(id, "_index.md"))
		if bErr != nil {
			return "", bErr
		}
		if err := os.MkdirAll(filepath.Dir(bundleAbs), 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(leafAbs, bundleAbs); err != nil {
			return "", fmt.Errorf("leaf→bundle: %w", err)
		}
		gitOld := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, id+".md"))
		gitNew := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, id, "_index.md"))
		if err := r.git(ctx, "add", "--", gitOld, gitNew); err != nil {
			return "", err
		}
		// Commit migration separately to keep history clean.
		if err := r.git(ctx, "diff", "--cached", "--quiet"); err != nil {
			name := u.Name
			if name == "" { name = u.Login }
			email := u.Email
			if email == "" { email = u.Login + "@users.noreply.github.com" }
			env := []string{
				"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
				"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
			}
			if err := r.gitEnv(ctx, env, "commit", "-m", "wiki: migrate to bundle "+id); err != nil {
				return "", err
			}
		}
	}

	// Write asset.
	ext := filepath.Ext(filename)
	if ext == "" {
		ext = extBySniff(body)
	}
	base := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if base == "" {
		base = "asset"
	}
	// short content hash for uniqueness
	h := sha1.New()
	data, err := io.ReadAll(io.TeeReader(body, h))
	if err != nil {
		return "", err
	}
	shortHash := hex.EncodeToString(h.Sum(nil))[:8]
	safeBase := sanitizeFilename(base)
	finalName := safeBase + "-" + shortHash + ext

	assetsDirAbs, _ := r.resolvePath(filepath.Join(id, "assets"))
	if err := os.MkdirAll(assetsDirAbs, 0o755); err != nil {
		return "", err
	}
	assetAbs := filepath.Join(assetsDirAbs, finalName)
	if err := os.WriteFile(assetAbs, data, 0o644); err != nil {
		return "", err
	}
	gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, id, "assets", finalName))
	if err := r.git(ctx, "add", "--", gitPath); err != nil {
		return "", err
	}
	name := u.Name
	if name == "" { name = u.Login }
	email := u.Email
	if email == "" { email = u.Login + "@users.noreply.github.com" }
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	if err := r.gitEnv(ctx, env, "commit", "-m", "wiki: add asset "+id+"/assets/"+finalName); err != nil {
		return "", err
	}
	if err := r.setPushToken(ctx, u.Token); err != nil {
		return "", err
	}
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return "", fmt.Errorf("%w: %v", ErrPush, err)
	}
	return "assets/" + finalName, nil
}

func sanitizeFilename(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
	}
	out := b.String()
	if out == "" {
		out = "asset"
	}
	return out
}

func extBySniff(r io.Reader) string {
	buf := make([]byte, 512)
	n, _ := r.Read(buf)
	mt := http.DetectContentType(buf[:n])
	// can't un-read; ignore stream since we re-read afterwards via TeeReader
	exts, _ := mime.ExtensionsByType(mt)
	if len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}
