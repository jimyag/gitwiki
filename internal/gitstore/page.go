package gitstore

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/jimyag/gitwiki/internal/auth"
)

// Page abstracts a Hugo content page. Two physical forms:
//   - leaf:   content/<id>.md
//   - bundle: content/<id>/_index.md, can have children and page-attached assets
// Page operations automatically migrate between forms.
type Page struct {
	ID       string   `json:"id"`       // e.g. "guide/install" - slash-separated, no extension
	Title    string   `json:"title"`    // from front matter, fallback to last segment
	Weight   int      `json:"weight"`   // 0 means unset
	IsDir    bool     `json:"is_dir"`   // bundle form (or virtual: has children)
	HasBody  bool     `json:"has_body"` // has backing markdown file
	Tags     []string `json:"tags,omitempty"`
	Draft    bool     `json:"draft,omitzero"`
	Children []*Page  `json:"children,omitempty"`
}

var (
	// ErrNotFound is returned when page content does not exist.
	ErrNotFound = errors.New("page not found")
	// ErrExists is returned when the destination of a move or restore is taken.
	ErrExists = errors.New("page already exists")
)

// Meta is the front matter gitwiki edits besides the title. Every other field is kept as is.
type Meta struct {
	Tags        []string `json:"tags"`
	Draft       bool     `json:"draft"`
	Description string   `json:"description"`
	Date        string   `json:"date"`
}

// MetaOf reads Meta from parsed front matter.
func MetaOf(fm map[string]any) Meta {
	m := Meta{Tags: []string{}}
	switch t := fm["tags"].(type) {
	case []any:
		for _, v := range t {
			if s := fmt.Sprint(v); s != "" {
				m.Tags = append(m.Tags, s)
			}
		}
	case string:
		if t != "" {
			m.Tags = append(m.Tags, t)
		}
	}
	m.Draft, _ = fm["draft"].(bool)
	m.Description, _ = fm["description"].(string)
	m.Date, _ = fm["date"].(string)
	return m
}

// Apply writes the fields of m that differ from fm into it; untouched fields keep their
// original form, and an emptied field drops its key.
func (m Meta) Apply(fm map[string]any) {
	cur := MetaOf(fm)
	set := func(key string, changed, empty bool, v any) {
		switch {
		case !changed:
		case empty:
			delete(fm, key)
		default:
			fm[key] = v
		}
	}
	set("tags", !slices.Equal(cur.Tags, m.Tags), len(m.Tags) == 0, m.Tags)
	set("draft", cur.Draft != m.Draft, !m.Draft, true)
	set("description", cur.Description != m.Description, m.Description == "", m.Description)
	set("date", cur.Date != m.Date, m.Date == "", m.Date)
}

// commitAs commits what is staged with u as author and committer.
func (r *Repo) commitAs(ctx context.Context, u *auth.User, message string) error {
	name := cmp.Or(u.Name, u.Login)
	email := cmp.Or(u.Email, u.Login+"@users.noreply.github.com")
	env := []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
	return r.gitEnv(ctx, env, "commit", "-q", "-m", message)
}

// gitPath turns a path relative to the content dir into one relative to the repo root.
func (r *Repo) gitPath(rel string) string {
	return path.Join(r.cfg.ContentDir, filepath.ToSlash(rel))
}

// assetsDir is page id's attachment folder relative to the content dir. The home page is the
// content root's bundle, so its attachments sit in content/assets.
func assetsDir(id string) string {
	if id == HomeID {
		return "assets"
	}
	return id + "/assets"
}

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
	r.mu.RLock()
	defer r.mu.RUnlock()
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
				p := readPageInfo(path, base)
				p.ID, p.HasBody = id, true
				cur.Children = append(cur.Children, p)
				continue
			}
			if last && isIndexMD {
				// bundle _index.md contributes title/weight to its parent dir page
				if len(parts) == 1 {
					root.HasBody = true
					continue
				}
				info := readPageInfo(path, parts[len(parts)-2])
				parentID := strings.Join(parts[:len(parts)-1], "/")
				if n := findByID(root, parentID); n != nil {
					n.Title, n.Weight, n.Tags, n.Draft = info.Title, info.Weight, info.Tags, info.Draft
				}
				continue
			}
			// Non-final segments are always directories we need to descend into.
			// Final segment here is also a directory (not a .md file).
			isDirSegment := !last || de.IsDir()
			if !isDirSegment {
				continue
			}
			id := strings.Join(parts[:i+1], "/")
			var next *Page
			for _, c := range cur.Children {
				if c.ID == id && c.IsDir {
					next = c
					break
				}
			}
			if next == nil {
				next = &Page{ID: id, Title: p, IsDir: true}
				absDir := filepath.Join(contentRoot, filepath.FromSlash(id))
				if _, err := os.Stat(filepath.Join(absDir, "_index.md")); err == nil {
					next.HasBody = true
				}
				cur.Children = append(cur.Children, next)
			}
			cur = next
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
	r.mu.RLock()
	defer r.mu.RUnlock()
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
	if errors.Is(err, ErrNotFound) && baseSHA != "" {
		// Edited from a loaded page that has since been deleted or moved: recreating it here
		// would resurrect a stray copy.
		return "", err
	}
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

	// Conflicts are judged against the local HEAD: every gitwiki edit lands there first.
	// Edits pushed to GitHub from elsewhere are folded in by the background push (rebase).
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
	if err := r.commitAs(ctx, u, cmp.Or(message, "wiki: update "+id)); err != nil {
		return "", err
	}
	sha, err := r.headSHA(ctx)
	if err != nil {
		return "", err
	}
	r.schedulePush(u.Token)
	return sha, nil
}

// CreatePage creates an empty page with front matter. If parentID != "", page is nested.
// Slug is generated server-side; users only see and edit titles. Rapid duplicate calls
// with the same (parentID, title) within 30s return the prior id — guards double-clicks.
func (r *Repo) CreatePage(ctx context.Context, parentID, title string, u *auth.User) (string, error) {
	if title == "" {
		return "", ErrBadPath
	}
	if parentID == HomeID { // the home page's children are the top-level pages
		parentID = ""
	}
	dedupKey := parentID + "|" + title
	r.recentCreateMu.Lock()
	if r.recentCreate == nil {
		r.recentCreate = map[string]recentCreate{}
	}
	if rc, ok := r.recentCreate[dedupKey]; ok && time.Since(rc.at) < 30*time.Second {
		r.recentCreateMu.Unlock()
		return rc.id, nil
	}
	r.recentCreateMu.Unlock()
	// Generate a random slug, retry on collision (astronomically rare).
	var id string
	for i := 0; i < 5; i++ {
		slug := randomSlug(12)
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
	// A leaf parent must become a bundle to host children. The rename is only staged here;
	// SavePage's commit below picks it up together with the new page.
	if parentID != "" {
		r.mu.Lock()
		abs, isBundle, err := r.diskPath(parentID)
		switch {
		case errors.Is(err, ErrNotFound): // plain directory without a page file: nothing to promote
			err = nil
		case err == nil && !isBundle:
			err = r.promoteToBundle(ctx, parentID, abs)
		}
		r.mu.Unlock()
		if err != nil {
			return "", err
		}
	}
	doc := &PageDoc{
		FrontMatter: map[string]any{"title": title},
		Body:        "",
	}
	if _, err := r.SavePage(ctx, id, doc, "", "wiki: new page "+title, u); err != nil {
		return "", err
	}
	r.recentCreateMu.Lock()
	r.recentCreate[dedupKey] = recentCreate{id: id, at: time.Now()}
	r.recentCreateMu.Unlock()
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

// promoteToBundle moves leaf <id>.md (at leafAbs) to <id>/_index.md and stages both paths,
// so the rename lands in the caller's next commit. Caller holds r.mu.
func (r *Repo) promoteToBundle(ctx context.Context, id, leafAbs string) error {
	bundleAbs, err := r.resolvePath(filepath.Join(id, "_index.md"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(bundleAbs), 0o755); err != nil {
		return err
	}
	if err := os.Rename(leafAbs, bundleAbs); err != nil {
		return fmt.Errorf("leaf→bundle: %w", err)
	}
	gitOld := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, id+".md"))
	gitNew := filepath.ToSlash(filepath.Join(r.cfg.ContentDir, id, "_index.md"))
	return r.git(ctx, "add", "--", gitOld, gitNew)
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
	if errors.Is(err, ErrNotFound) && id == HomeID { // no home page yet: content/assets still works
		err = nil
	}
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

	// The home page (content/_index.md) already is the content root's bundle.
	if !isBundle && id != HomeID {
		if err := r.promoteToBundle(ctx, id, abs); err != nil {
			return "", err
		}
		// Commit migration separately to keep history clean.
		if err := r.git(ctx, "diff", "--cached", "--quiet"); err != nil {
			if err := r.commitAs(ctx, u, "wiki: migrate to bundle "+id); err != nil {
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
	shortHash := hex.EncodeToString(h.Sum(nil))[:12]
	safeBase := sanitizeFilename(base)
	finalName := safeBase + "-" + shortHash + ext

	assetsDirAbs, err := r.resolvePath(assetsDir(id))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(assetsDirAbs, 0o755); err != nil {
		return "", err
	}
	assetAbs := filepath.Join(assetsDirAbs, finalName)
	if err := os.WriteFile(assetAbs, data, 0o644); err != nil {
		return "", err
	}
	gitPath := r.gitPath(assetsDir(id) + "/" + finalName)
	if err := r.git(ctx, "add", "--", gitPath); err != nil {
		return "", err
	}
	if err := r.commitAs(ctx, u, "wiki: add asset "+gitPath); err != nil {
		return "", err
	}
	r.schedulePush(u.Token)
	return "assets/" + finalName, nil
}

// DeleteAsset removes attachment name of page id.
func (r *Repo) DeleteAsset(ctx context.Context, id, name string, u *auth.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, err := r.AssetPath(id, name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return ErrNotFound
	}
	gitPath := r.gitPath(assetsDir(id) + "/" + name)
	if err := r.git(ctx, "rm", "-q", "--", gitPath); err != nil {
		return err
	}
	if err := r.commitAs(ctx, u, "wiki: delete asset "+gitPath); err != nil {
		return err
	}
	r.schedulePush(u.Token)
	return nil
}

// sanitizeFilename keeps letters and digits of any script (people find "需求说明.pdf" again by
// its name), '-', '_' and '.', and turns spaces into '-'.
func sanitizeFilename(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '-', r == '_', r == '.':
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
// DeletePage removes page id together with its children and attachments, in one commit.
// Git keeps the files: RecentChanges lists the deletion and RestorePage undoes it.
func (r *Repo) DeletePage(ctx context.Context, id string, u *auth.User) error {
	if id == HomeID {
		return ErrBadPath
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, _, err := r.diskPath(id); err != nil {
		return err
	}
	// Both forms, so a leaf with a same-named folder of children goes as a whole too.
	if err := r.git(ctx, "rm", "-r", "-q", "--ignore-unmatch", "--", r.gitPath(id+".md"), r.gitPath(id)); err != nil {
		return err
	}
	if err := r.commitAs(ctx, u, "wiki: delete "+id); err != nil {
		return err
	}
	r.schedulePush(u.Token)
	return nil
}

// MovePage moves page id, with its children and attachments, under newParent ("" or the home
// page for the top level). The page keeps its slug; links to it and to its children are
// rewritten in the same commit. It returns the new id and how many pages had links rewritten.
func (r *Repo) MovePage(ctx context.Context, id, newParent string, u *auth.User) (string, int, error) {
	if newParent == HomeID {
		newParent = ""
	}
	if id == HomeID || newParent == id || strings.HasPrefix(newParent, id+"/") {
		return "", 0, ErrBadPath
	}
	newID := path.Join(newParent, path.Base(id))
	if newID == id {
		return id, 0, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	abs, isBundle, err := r.diskPath(id)
	if err != nil {
		return "", 0, err
	}
	dst, err := r.resolvePath(newID)
	if err != nil {
		return "", 0, err
	}
	if _, err := os.Stat(dst + ".md"); err == nil {
		return "", 0, ErrExists
	}
	if _, err := os.Stat(dst); err == nil {
		return "", 0, ErrExists
	}
	if newParent != "" {
		parentAbs, parentIsBundle, err := r.diskPath(newParent)
		switch {
		case errors.Is(err, ErrNotFound): // a folder without a page file can hold pages too
			dir, _ := r.resolvePath(newParent)
			if st, err := os.Stat(dir); err != nil || !st.IsDir() {
				return "", 0, ErrNotFound
			}
		case err != nil:
			return "", 0, err
		case !parentIsBundle:
			if err := r.promoteToBundle(ctx, newParent, parentAbs); err != nil {
				return "", 0, err
			}
		}
	}
	from, to := abs, dst+".md"
	oldGit, newGit := r.gitPath(id+".md"), r.gitPath(newID+".md")
	if isBundle {
		from, to = filepath.Dir(abs), dst
		oldGit, newGit = r.gitPath(id), r.gitPath(newID)
	}
	if err := os.Rename(from, to); err != nil {
		return "", 0, err
	}
	if err := r.git(ctx, "add", "-A", "--", oldGit, newGit); err != nil {
		return "", 0, err
	}
	n, err := r.rewriteLinks(ctx, id, newID)
	if err != nil {
		return "", 0, err
	}
	if err := r.commitAs(ctx, u, fmt.Sprintf("wiki: move %s → %s", id, newID)); err != nil {
		return "", 0, err
	}
	r.schedulePush(u.Token)
	return newID, n, nil
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
	msg := fmt.Sprintf("wiki: reorder pages under %s", parentID)
	if parentID == "" { msg = "wiki: reorder top-level pages" }
	if err := r.commitAs(ctx, u, msg); err != nil { return err }
	r.schedulePush(u.Token)
	return nil
}

// readPageInfo reads the tree fields (title, weight, tags, draft) from a page file's front
// matter, best effort. The title falls back to fallbackTitle.
func readPageInfo(absPath string, fallbackTitle string) *Page {
	p := &Page{Title: fallbackTitle}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return p
	}
	doc, _ := ParsePage(data)
	p.Title = pageTitle(doc, fallbackTitle)
	switch w := doc.FrontMatter["weight"].(type) {
	case int:
		p.Weight = w
	case int64:
		p.Weight = int(w)
	case float64:
		p.Weight = int(w)
	}
	m := MetaOf(doc.FrontMatter)
	if len(m.Tags) > 0 {
		p.Tags = m.Tags
	}
	p.Draft = m.Draft
	return p
}

func findByID(root *Page, id string) *Page {
	if root.ID == id { return root }
	for _, c := range root.Children {
		if n := findByID(c, id); n != nil { return n }
	}
	return nil
}


// UpdateTitle changes the page title front matter without renaming the file.
// The id stays the same, so links to the page keep working.
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
	r.mu.RLock()
	defer r.mu.RUnlock()
	abs, err := r.resolvePath(assetsDir(pageID))
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

// AssetPath returns the on-disk path of a file inside <page>/assets/. Name is the raw filename.
// No lock: it only validates the path; serving happens on an open file descriptor.
func (r *Repo) AssetPath(pageID, name string) (string, error) {
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", ErrBadPath
	}
	return r.resolvePath(filepath.Join(assetsDir(pageID), name))
}


