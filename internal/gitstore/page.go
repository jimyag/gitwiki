package gitstore

import (
	"bytes"
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
	Title   string  `json:"title"`    // from front matter, fallback to last segment
	Weight  int     `json:"weight"`   // 0 means unset
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
		// Skip asset directories; they hold page attachments, not pages.
		if de.IsDir() && name == "assets" {
			return filepath.SkipDir
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
				title, weight := readTitleWeight(path, base)
				cur.Children = append(cur.Children, &Page{ID: id, Title: title, Weight: weight, HasBody: true})
				continue
			}
			if last && isIndexMD {
				// bundle _index.md contributes title/weight to its parent dir page
				if len(parts) == 1 {
					root.HasBody = true
					continue
				}
				title, weight := readTitleWeight(path, parts[len(parts)-2])
				parentID := strings.Join(parts[:len(parts)-1], "/")
				if n := findByID(root, parentID); n != nil {
					if title != "" && title != parts[len(parts)-2] { n.Title = title }
					n.Weight = weight
				}
				continue
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
	sort.SliceStable(p.Children, func(i, j int) bool {
		a, b := p.Children[i], p.Children[j]
		aw, bw := a.Weight, b.Weight
		if aw == 0 { aw = 1 << 30 }
		if bw == 0 { bw = 1 << 30 }
		if aw != bw { return aw < bw }
		return a.ID < b.ID
	})
	for _, c := range p.Children {
		sortTree(c)
	}
}

// ReadPage returns the page's content split into front matter / body, plus base SHA.
func (r *Repo) ReadPage(ctx context.Context, id string) (*PageContent, bool, error) {
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
	doc, err := ParsePage(data)
	if err != nil {
		return nil, false, err
	}
	title, _ := doc.FrontMatter["title"].(string)
	pc := &PageContent{
		ID:      id,
		Title:   title,
		Body:    doc.Body,
		RawMeta: doc.FrontMatter,
		BaseSHA: head,
	}
	// Best-effort: last commit touching this file.
	gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, relToMd(id, isBundle)))
	if out, err := r.gitOut(ctx, "log", "-1", "--format=%an%x1f%H%x1f%cI", "--", gitPath); err == nil {
		line := strings.TrimSpace(string(out))
		parts := strings.SplitN(line, "\x1f", 3)
		if len(parts) == 3 {
			pc.LastAuthor = parts[0]
			pc.LastCommitSHA = parts[1]
			pc.LastCommitAt = parts[2]
		}
	}
	return pc, isBundle, nil
}

type PageContent struct {
	ID            string
	Title         string
	Body          string
	RawMeta       map[string]any // server-side canonical front matter; UI does not see this
	BaseSHA       string
	LastAuthor    string
	LastCommitSHA string
	LastCommitAt  string // RFC3339
}

// SavePage saves the page body, migrating leaf↔bundle as needed.
// `hasChildren` indicates whether the page needs bundle form after save.
// We don't know future children so this just chooses based on what exists on disk.
func (r *Repo) SavePage(ctx context.Context, id string, doc *PageDoc, baseSHA, message string, u *auth.User) (string, error) {
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

	// Serialize the page once so that conflict text and final write use identical bytes.
	contentBytes, err := RenderPage(doc)
	if err != nil {
		return "", err
	}
	if localHead != baseSHA {
		merged, conflict, err := r.merge3(ctx, relToMd(id, isBundle), baseSHA, localHead, string(contentBytes))
		if err != nil {
			return "", err
		}
		if conflict {
			baseDoc, _ := r.readDocAt(ctx, relToMd(id, isBundle), baseSHA)
			headDoc, _ := r.readDocAt(ctx, relToMd(id, isBundle), localHead)
			var baseBody, theirsBody string
			if baseDoc != nil { baseBody = baseDoc.Body }
			if headDoc != nil { theirsBody = headDoc.Body }
			return "", &ConflictError{
				Path: id, Merged: merged, CurrentSHA: localHead,
				TheirsBody: theirsBody, OursBody: doc.Body, BaseBody: baseBody,
			}
		}
		contentBytes = []byte(merged)
		if err := r.git(ctx, "merge", "--ff-only", "origin/"+r.cfg.Branch); err != nil {
			return "", fmt.Errorf("ff: %w", err)
		}
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, contentBytes, 0o644); err != nil {
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
	doc := &PageDoc{
		FrontMatter: map[string]any{"title": title},
		Body:        "",
	}
	sha, err := r.SavePage(ctx, id, doc, "", "wiki: new page "+id, u)
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
// DeletePage removes a page. For leaf pages removes the .md file. For bundle pages
// removes _index.md and (only if keepChildren=false) the whole directory.
// Currently requires keepChildren=true (we refuse to cascade).
func (r *Repo) DeletePage(ctx context.Context, id string, u *auth.User, message string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, isBundle, err := r.diskPath(id)
	if err != nil {
		return err
	}
	if isBundle {
		// Check for children
		dir := filepath.Dir(abs)
		ents, _ := os.ReadDir(dir)
		hasOthers := false
		for _, e := range ents {
			if e.Name() != "_index.md" {
				hasOthers = true
				break
			}
		}
		if hasOthers {
			return fmt.Errorf("bundle page %q still has children or assets; delete them first", id)
		}
	}
	if err := os.Remove(abs); err != nil {
		return err
	}
	gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, relToMd(id, isBundle)))
	r.git(ctx, "rm", "-q", "--", gitPath) // may already be staged by os.Remove
	if err := r.git(ctx, "add", "-u", "--", gitPath); err != nil {
		return err
	}
	if message == "" {
		message = "wiki: delete " + id
	}
	name := u.Name
	if name == "" { name = u.Login }
	email := u.Email
	if email == "" { email = u.Login + "@users.noreply.github.com" }
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	if err := r.gitEnv(ctx, env, "commit", "-m", message); err != nil {
		return err
	}
	if err := r.setPushToken(ctx, u.Token); err != nil {
		return err
	}
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return fmt.Errorf("%w: %v", ErrPush, err)
	}
	return nil
}

// RenamePage moves a page (incl. its assets dir) to a new ID. Renames use git mv if both
// source and destination exist as files; else it falls back to os.Rename + git add -A.
func (r *Repo) RenamePage(ctx context.Context, oldID, newID string, u *auth.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if oldID == "" || newID == "" || oldID == newID {
		return ErrBadPath
	}
	abs, isBundle, err := r.diskPath(oldID)
	if err != nil {
		return err
	}
	// Refuse if destination already exists.
	if _, _, err := r.diskPath(newID); err == nil {
		return fmt.Errorf("destination exists: %s", newID)
	}
	if isBundle {
		// Move whole directory: <old>/ → <new>/
		srcDir := filepath.Dir(abs)
		dstDir, e := r.resolvePath(newID)
		if e != nil { return e }
		if err := os.MkdirAll(filepath.Dir(dstDir), 0o755); err != nil { return err }
		if err := os.Rename(srcDir, dstDir); err != nil { return err }
		gitOld := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, oldID))
		gitNew := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, newID))
		if err := r.git(ctx, "add", "-A", "--", gitOld, gitNew); err != nil { return err }
	} else {
		// Leaf move: content/old.md → content/new.md
		dst, e := r.resolvePath(newID + ".md")
		if e != nil { return e }
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil { return err }
		if err := os.Rename(abs, dst); err != nil { return err }
		gitOld := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, oldID+".md"))
		gitNew := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, newID+".md"))
		if err := r.git(ctx, "add", "-A", "--", gitOld, gitNew); err != nil { return err }
	}
	name := u.Name
	if name == "" { name = u.Login }
	email := u.Email
	if email == "" { email = u.Login + "@users.noreply.github.com" }
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	msg := fmt.Sprintf("wiki: rename %s → %s", oldID, newID)
	if err := r.gitEnv(ctx, env, "commit", "-m", msg); err != nil { return err }
	if err := r.setPushToken(ctx, u.Token); err != nil { return err }
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return fmt.Errorf("%w: %v", ErrPush, err)
	}
	return nil
}

type ConflictError struct {
	Path       string
	Merged     string // content with conflict markers (whole file, including front matter)
	CurrentSHA string
	TheirsBody string // body at current HEAD (front matter stripped)
	OursBody   string // body the user tried to save
	BaseBody   string // body of the base version
}

func (e *ConflictError) Error() string { return "conflict in " + e.Path }
func (e *ConflictError) Unwrap() error { return ErrConflict }

// readDocAt reads the doc at the given sha. Best-effort; returns nil on missing.
func (r *Repo) readDocAt(ctx context.Context, relMd string, sha string) (*PageDoc, error) {
	out, err := r.gitOut(ctx, "show", sha+":"+filepath.ToSlash(filepath.Join(r.cfg.ContentDir, relMd)))
	if err != nil {
		return nil, err
	}
	return ParsePage(out)
}

// OrderChildren rewrites the `weight` front matter of each child of parentID
// in the order given. IDs must all live directly under parentID.
// Single commit; if any page fails, no commit is made.
func (r *Repo) OrderChildren(ctx context.Context, parentID string, orderedIDs []string, u *auth.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(orderedIDs) == 0 {
		return nil
	}
	// ensure parent prefix matches
	for _, id := range orderedIDs {
		wantPrefix := ""
		if parentID != "" {
			wantPrefix = parentID + "/"
		}
		if !strings.HasPrefix(id, wantPrefix) {
			return fmt.Errorf("id %q is not a direct child of %q", id, parentID)
		}
		rest := strings.TrimPrefix(id, wantPrefix)
		if strings.Contains(rest, "/") {
			return fmt.Errorf("id %q is not a direct child of %q", id, parentID)
		}
	}
	name := u.Name
	if name == "" { name = u.Login }
	email := u.Email
	if email == "" { email = u.Login + "@users.noreply.github.com" }

	for i, id := range orderedIDs {
		abs, isBundle, err := r.diskPath(id)
		if err != nil {
			return fmt.Errorf("page %q: %w", id, err)
		}
		data, err := os.ReadFile(abs)
		if err != nil { return err }
		doc, err := ParsePage(data)
		if err != nil { return err }
		doc.FrontMatter["weight"] = (i + 1) * 10 // leave gaps for future inserts
		out, err := RenderPage(doc)
		if err != nil { return err }
		if bytes.Equal(data, out) { continue }
		if err := os.WriteFile(abs, out, 0o644); err != nil { return err }
		gitPath := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, relToMd(id, isBundle)))
		if err := r.git(ctx, "add", "--", gitPath); err != nil { return err }
	}
	if err := r.git(ctx, "diff", "--cached", "--quiet"); err == nil {
		return nil
	}
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	msg := fmt.Sprintf("wiki: reorder pages under %s", parentID)
	if parentID == "" { msg = "wiki: reorder top-level pages" }
	if err := r.gitEnv(ctx, env, "commit", "-m", msg); err != nil { return err }
	if err := r.setPushToken(ctx, u.Token); err != nil { return err }
	if err := r.git(ctx, "push", "origin", r.cfg.Branch); err != nil {
		return fmt.Errorf("%w: %v", ErrPush, err)
	}
	return nil
}

// readTitleWeight best-effort: parse front matter for title+weight. Falls back to fallbackTitle.
func readTitleWeight(absPath string, fallbackTitle string) (title string, weight int) {
	data, err := os.ReadFile(absPath)
	if err != nil { return fallbackTitle, 0 }
	doc, err := ParsePage(data)
	if err != nil { return fallbackTitle, 0 }
	if t, ok := doc.FrontMatter["title"].(string); ok && t != "" { title = t } else { title = fallbackTitle }
	switch w := doc.FrontMatter["weight"].(type) {
	case int:
		weight = w
	case int64:
		weight = int(w)
	case float64:
		weight = int(w)
	}
	return
}

func findByID(root *Page, id string) *Page {
	if root.ID == id { return root }
	for _, c := range root.Children {
		if n := findByID(c, id); n != nil { return n }
	}
	return nil
}
