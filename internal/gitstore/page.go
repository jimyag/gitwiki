package gitstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
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
// Slug is generated server-side; users only see and edit titles.
func (r *Repo) CreatePage(ctx context.Context, parentID, title string, u *auth.User) (string, error) {
	if title == "" {
		return "", ErrBadPath
	}
	// Generate a random slug, retry on collision (astronomically rare).
	var id string
	for i := 0; i < 5; i++ {
		slug := randomSlug(8)
		candidate := slug
		if parentID != "" {
			candidate = parentID + "/" + slug
		}
		if _, _, err := r.diskPath(candidate); errors.Is(err, ErrNotFound) {
			id = candidate
			break
		}
	}
	if id == "" {
		return "", fmt.Errorf("could not allocate unique slug")
	}
	doc := &PageDoc{
		FrontMatter: map[string]any{"title": title},
		Body:        "",
	}
	if _, err := r.SavePage(ctx, id, doc, "", "wiki: new page "+title, u); err != nil {
		return "", err
	}
	return id, nil
}

const slugAlphabet = "23456789abcdefghjkmnpqrstuvwxyz" // no 0/1/o/i/l to avoid visual ambiguity

func randomSlug(n int) string {
	b := make([]byte, n)
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = slugAlphabet[int(raw[i])%len(slugAlphabet)]
	}
	return string(b)
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


// SearchResult is one matched line in one page.
type SearchResult struct {
	PageID  string `json:"page_id"`
	Title   string `json:"title"`
	Path    string `json:"path"`
	Line    int    `json:"line"` // 1-based; 0 means filename/title-only match
	Snippet string `json:"snippet"`
}

// Search uses ripgrep when available, otherwise falls back to a Go walk.
// Query matches title, body, and file path, case-insensitively. Result capped at 50.
func (r *Repo) Search(ctx context.Context, q string) ([]SearchResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if q == "" || len(q) > 256 {
		return nil, ErrBadPath
	}
	contentRoot := filepath.Join(r.cfg.Workdir, r.cfg.ContentDir)
	if rg, err := exec.LookPath("rg"); err == nil {
		return r.searchWithRg(ctx, rg, q, contentRoot)
	}
	return r.searchWithWalk(ctx, q, contentRoot)
}

func (r *Repo) searchWithRg(ctx context.Context, rg, q, contentRoot string) ([]SearchResult, error) {
	contentCmd := exec.CommandContext(ctx, rg,
		"--json", "-i", "--max-count", "5",
		"-g", "*.md", "-g", "!**/assets/**",
		"--", q,
	)
	contentCmd.Dir = contentRoot
	contentOut, _ := contentCmd.Output()

	pathCmd := exec.CommandContext(ctx, rg, "--files", "-g", "*.md", "-g", "!**/assets/**")
	pathCmd.Dir = contentRoot
	pathOut, _ := pathCmd.Output()

	results := []SearchResult{}
	seenContent := map[string]bool{}
	titleCache := map[string]string{}

	for _, line := range bytes.Split(contentOut, []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var ev struct {
			Type string `json:"type"`
			Data struct {
				Path  struct{ Text string `json:"text"` } `json:"path"`
				Lines struct{ Text string `json:"text"` } `json:"lines"`
				LineNumber int `json:"line_number"`
			} `json:"data"`
		}
		if json.Unmarshal(line, &ev) != nil || ev.Type != "match" {
			continue
		}
		rel := filepath.ToSlash(ev.Data.Path.Text)
		id, title := r.pageIDAndTitle(rel, contentRoot, titleCache)
		snippet := strings.TrimSpace(ev.Data.Lines.Text)
		if len(snippet) > 200 {
			snippet = snippet[:200] + "…"
		}
		key := id + "|" + snippet
		if seenContent[key] {
			continue
		}
		seenContent[key] = true
		results = append(results, SearchResult{
			PageID: id, Title: title, Path: rel,
			Line: ev.Data.LineNumber, Snippet: snippet,
		})
		if len(results) >= 50 {
			return results, nil
		}
	}

	qLower := strings.ToLower(q)
	for _, ln := range bytes.Split(pathOut, []byte("\n")) {
		if len(ln) == 0 {
			continue
		}
		rel := filepath.ToSlash(string(ln))
		if !strings.Contains(strings.ToLower(rel), qLower) {
			continue
		}
		id, title := r.pageIDAndTitle(rel, contentRoot, titleCache)
		results = append(results, SearchResult{
			PageID: id, Title: title, Path: rel,
			Line: 0, Snippet: "路径匹配: " + rel,
		})
		if len(results) >= 50 {
			return results, nil
		}
	}
	return results, nil
}

func (r *Repo) searchWithWalk(ctx context.Context, q, contentRoot string) ([]SearchResult, error) {
	qLower := strings.ToLower(q)
	out := []SearchResult{}
	titleCache := map[string]string{}
	err := filepath.WalkDir(contentRoot, func(path string, de os.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			if de != nil && de.IsDir() && (strings.HasPrefix(de.Name(), ".") || de.Name() == "assets") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(de.Name(), ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if len(data) > 200_000 {
			data = data[:200_000]
		}
		doc, err := ParsePage(data)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(contentRoot, path)
		rel = filepath.ToSlash(rel)
		id, title := r.pageIDAndTitle(rel, contentRoot, titleCache)
		if strings.Contains(strings.ToLower(title), qLower) || strings.Contains(strings.ToLower(rel), qLower) {
			out = append(out, SearchResult{PageID: id, Title: title, Path: rel, Line: 0, Snippet: "标题 / 路径匹配"})
		}
		for i, line := range strings.Split(doc.Body, "\n") {
			if strings.Contains(strings.ToLower(line), qLower) {
				sn := strings.TrimSpace(line)
				if len(sn) > 200 {
					sn = sn[:200] + "…"
				}
				out = append(out, SearchResult{PageID: id, Title: title, Path: rel, Line: i + 1, Snippet: sn})
				if len(out) >= 50 {
					return io.EOF
				}
			}
		}
		return nil
	})
	if err != nil && err != io.EOF {
		return nil, err
	}
	return out, nil
}

func (r *Repo) pageIDAndTitle(rel, contentRoot string, cache map[string]string) (string, string) {
	var id string
	if strings.HasSuffix(rel, "/_index.md") {
		id = strings.TrimSuffix(rel, "/_index.md")
	} else {
		id = strings.TrimSuffix(rel, ".md")
	}
	if t, ok := cache[id]; ok {
		return id, t
	}
	abs := filepath.Join(contentRoot, filepath.FromSlash(rel))
	title := id
	if data, err := os.ReadFile(abs); err == nil {
		if doc, err := ParsePage(data); err == nil {
			if fmTitle, ok := doc.FrontMatter["title"].(string); ok && fmTitle != "" {
				title = fmTitle
			}
		}
	}
	cache[id] = title
	return id, title
}

// UpdateTitle changes the page title front matter without renaming the file.
// Cleaner than RenamePage — keeps ids stable, links don't break.
func (r *Repo) UpdateTitle(ctx context.Context, id, newTitle string, u *auth.User) (string, error) {
	if newTitle == "" {
		return "", ErrBadPath
	}
	pc, _, err := r.ReadPage(ctx, id)
	if err != nil {
		return "", err
	}
	doc := &PageDoc{FrontMatter: pc.RawMeta, Body: pc.Body}
	doc.FrontMatter["title"] = newTitle
	return r.SavePage(ctx, id, doc, pc.BaseSHA, "wiki: rename "+newTitle, u)
}


// ListAssets returns filenames under <page>/assets/.
func (r *Repo) ListAssets(ctx context.Context, pageID string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, err := r.resolvePath(filepath.Join(pageID, "assets"))
	if err != nil { return nil, err }
	ents, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) { return []string{}, nil }
		return nil, err
	}
	out := []string{}
	for _, e := range ents {
		if !e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// ReadAsset streams a single asset. Name is the raw filename inside <page>/assets/.
func (r *Repo) ReadAsset(ctx context.Context, pageID, name string) ([]byte, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if strings.Contains(name, "/") || strings.Contains(name, "..") {
		return nil, "", ErrBadPath
	}
	abs, err := r.resolvePath(filepath.Join(pageID, "assets", name))
	if err != nil { return nil, "", err }
	data, err := os.ReadFile(abs)
	if err != nil { return nil, "", err }
	mime := http.DetectContentType(data)
	return data, mime, nil
}
