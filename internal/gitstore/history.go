package gitstore

import (
	"context"
	"path"
	"strconv"
	"strings"

	"github.com/jimyag/gitwiki/internal/auth"
)

// Revision is one commit that changed a page.
type Revision struct {
	SHA     string `json:"sha"`
	Author  string `json:"author"`
	Date    string `json:"date"` // RFC 3339
	Message string `json:"message"`
	// LinksOnly: another page moved and this one only had its links to it rewritten.
	LinksOnly bool   `json:"links_only,omitzero"`
	file      string // the page's file in that commit, relative to the repo root
}

// housekeeping tells commits gitwiki makes to keep the page tree in shape (sort order, a page
// turned into a folder to hold attachments). They change no page's text, so neither a page's
// history nor the recent changes list them.
func housekeeping(subject string) bool {
	return strings.HasPrefix(subject, "wiki: reorder ") || strings.HasPrefix(subject, "wiki: migrate to bundle ")
}

// movedTo returns the new id of the page a move commit ("wiki: move <from> → <to>") moved.
// Other pages touched by it only had links rewritten or became a folder for the moved page.
func movedTo(subject string) (string, bool) {
	rest, ok := strings.CutPrefix(subject, "wiki: move ")
	if !ok {
		return "", false
	}
	_, to, ok := strings.Cut(rest, " → ")
	return to, ok
}

// within reports whether page id is root or a page under it.
func within(id, root string) bool { return id == root || strings.HasPrefix(id, root+"/") }

// HistoryLimit caps how many revisions History returns.
const HistoryLimit = 100

// logFormat starts each commit with \x1e and separates its fields with \x1f; the file list
// that --name-only / --name-status print follows on the next lines.
const logFormat = "--format=%x1e%H%x1f%an%x1f%aI%x1f%s"

type logEntry struct {
	sha, author, date, subject string
	files                      []string // --name-only paths or --name-status lines
}

func parseLog(out []byte) []logEntry {
	var entries []logEntry
	for rec := range strings.SplitSeq(string(out), "\x1e") {
		lines := strings.Split(strings.TrimSpace(rec), "\n")
		f := strings.Split(lines[0], "\x1f")
		if len(f) != 4 {
			continue
		}
		e := logEntry{sha: f[0], author: f[1], date: f[2], subject: f[3]}
		for _, l := range lines[1:] {
			if l != "" {
				e.files = append(e.files, l)
			}
		}
		entries = append(entries, e)
	}
	return entries
}

// History lists the commits that changed page id, newest first. It follows renames, so the
// commits from before a leaf → bundle promotion or a move are included.
func (r *Repo) History(ctx context.Context, id string) ([]Revision, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.history(ctx, id)
}

func (r *Repo) history(ctx context.Context, id string) ([]Revision, error) {
	_, isBundle, err := r.diskPath(id)
	if err != nil {
		return nil, err
	}
	return r.historyFile(ctx, r.gitPath(relToMd(id, isBundle)), "HEAD", HistoryLimit)
}

func (r *Repo) historyFile(ctx context.Context, file, revision string, limit int) ([]Revision, error) {
	if limit <= 0 {
		return []Revision{}, nil
	}
	out, err := r.gitOut(ctx, "-c", "core.quotePath=false", "log", "--follow", "--name-status",
		"-n", strconv.Itoa(limit), logFormat, revision, "--", file)
	if err != nil {
		return nil, err
	}
	revs := []Revision{}
	for _, e := range parseLog(out) {
		if len(e.files) == 0 || housekeeping(e.subject) {
			continue
		}
		f := strings.Split(e.files[0], "\t") // status, path (a rename: status, old, new)
		if f[0] == "D" {
			continue // deleted here and restored later: no version to show
		}
		rev := Revision{SHA: e.sha, Author: e.author, Date: e.date, Message: e.subject, file: f[len(f)-1]}
		if to, ok := movedTo(e.subject); ok {
			if pid, _ := r.pageOfFile(rev.file); !within(pid, to) {
				if f[0] != "M" {
					continue // became the moved page's parent folder: its text is unchanged
				}
				rev.LinksOnly = true
			}
		}
		revs = append(revs, rev)
		if to, ok := movedTo(e.subject); ok && f[0] == "A" {
			pid, _ := r.pageOfFile(rev.file)
			if within(pid, to) {
				// Git cannot detect a rename when link rewriting changes every line. The move
				// commit records the exact old path, so history need not rely on similarity.
				rest := strings.TrimPrefix(e.subject, "wiki: move ")
				from, _, _ := strings.Cut(rest, " → ")
				oldFile := r.gitPath(from) + strings.TrimPrefix(rev.file, r.gitPath(to))
				parents, err := r.gitOut(ctx, "rev-list", "--parents", "-n", "1", e.sha)
				if err != nil {
					return revs, err
				}
				fields := strings.Fields(string(parents))
				if len(fields) < 2 {
					return revs, nil
				} // root or shallow-clone boundary
				older, err := r.historyFile(ctx, oldFile, fields[1], limit-len(revs))
				return append(revs, older...), err
			}
		}
	}
	return revs, nil
}

// PageAt returns page id as of commit sha, which must be one of the page's History commits.
func (r *Repo) PageAt(ctx context.Context, id, sha string) (*PageDoc, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	revs, err := r.history(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, rev := range revs {
		if rev.SHA == sha {
			out, err := r.gitOut(ctx, "show", sha+":"+rev.file)
			if err != nil {
				return nil, err
			}
			return ParsePage(out)
		}
	}
	return nil, ErrNotFound
}

// Change is the latest change to a page.
type Change struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	SHA     string `json:"sha"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Message string `json:"message"`
	Deleted bool   `json:"deleted,omitzero"` // the change removed the page; RestorePage brings it back
}

// RecentChanges lists recently changed pages, newest first, one entry per page; attachment
// changes count for their page. Pages deleted together with their parent are folded into
// the parent's entry, pages that were moved away show up under their new id only, and pages
// whose links were merely rewritten by a move, like housekeeping commits, are not changes.
func (r *Repo) RecentChanges(ctx context.Context, limit int) ([]Change, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out, err := r.gitOut(ctx, "-c", "core.quotePath=false", "log", "-n", "300", "--name-status",
		logFormat, "--", r.cfg.ContentDir)
	if err != nil {
		return nil, err
	}
	changes := []Change{}
	seen := map[string]bool{}
	for _, e := range parseLog(out) {
		if housekeeping(e.subject) {
			continue
		}
		var ids []string
		deleted := map[string]string{} // page id → its markdown file, for pages this commit removed
		moved, isMove := movedTo(e.subject)
		for _, line := range e.files {
			f := strings.Split(line, "\t")
			file := f[len(f)-1] // a rename lists the old path, then the new one
			id, ok := r.pageOfFile(file)
			if !ok || isMove && !within(id, moved) {
				continue
			}
			if f[0] == "D" && strings.HasSuffix(file, ".md") {
				deleted[id] = file
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		for _, id := range ids {
			c := Change{ID: id, SHA: e.sha, Author: e.author, Date: e.date, Message: e.subject}
			if file, ok := deleted[id]; ok {
				if deletedWithParent(id, deleted) {
					continue
				}
				c.Deleted, c.Title = true, id
				if old, err := r.gitOut(ctx, "show", e.sha+"^:"+file); err == nil {
					doc, _ := ParsePage(old)
					c.Title = pageTitle(doc, id)
				}
			} else {
				abs, _, err := r.diskPath(id)
				if err != nil {
					continue // moved away: listed under the new id
				}
				c.Title = readPageInfo(abs, id).Title
			}
			changes = append(changes, c)
			if len(changes) == limit {
				return changes, nil
			}
		}
	}
	return changes, nil
}

func deletedWithParent(id string, deleted map[string]string) bool {
	for p := path.Dir(id); p != "."; p = path.Dir(p) {
		if _, ok := deleted[p]; ok {
			return true
		}
	}
	return false
}

// RestorePage brings back page id as it was just before commit sha deleted it, including the
// children and attachments that went with it, as a new commit.
func (r *Repo) RestorePage(ctx context.Context, id, sha string, u *auth.User) error {
	if !isSHA(sha) {
		return ErrBadPath
	}
	if _, err := r.resolvePath(id); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, _, err := r.diskPath(id); err == nil {
		return ErrExists
	}
	before := sha + "^"
	var files []string
	for _, f := range []string{r.gitPath(id + ".md"), r.gitPath(id)} {
		if r.git(ctx, "cat-file", "-e", before+":"+f) == nil {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return ErrNotFound
	}
	if err := r.git(ctx, append([]string{"checkout", before, "--"}, files...)...); err != nil {
		return err
	}
	// The parent may have become a leaf page since; it needs bundle form to hold the page.
	if parent := path.Dir(id); parent != "." {
		if abs, isBundle, err := r.diskPath(parent); err == nil && !isBundle {
			if err := r.promoteToBundle(ctx, parent, abs); err != nil {
				return err
			}
		}
	}
	if err := r.commitAs(ctx, u, "wiki: restore "+id); err != nil {
		return err
	}
	r.schedulePush(u.Token)
	return nil
}

func isSHA(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}
