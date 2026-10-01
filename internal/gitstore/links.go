package gitstore

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Links between wiki pages are written as site-absolute page paths, the path Hugo publishes
// the page under: [Title](/guide/install) or [Title](/guide/install#setup). Ids are those
// paths without the slashes; the home page (content/_index.md) has id HomeID and path "/".

// HomeID is the page id of the wiki's home page, content/_index.md.
const HomeID = "_index"

var (
	// The target must start with exactly one slash: "//host/x" is a protocol-relative URL.
	inlineLink = regexp.MustCompile(`(\]\(\s*)(/[^/)\s#?][^)\s#?]*)`)
	refLink    = regexp.MustCompile(`(?m)^(\s{0,3}\[[^\]]+\]:\s*)(/[^/\s#?][^\s#?]*)`)
)

// mapLinks rewrites the page link targets in markdown, skipping fenced code blocks.
// fn gets each target's page id and returns the replacement id, or ok=false to keep it.
func mapLinks(src string, fn func(id string) (to string, ok bool)) (string, bool) {
	changed := false
	repl := func(re *regexp.Regexp) func(string) string {
		return func(s string) string {
			m := re.FindStringSubmatch(s)
			if to, ok := fn(strings.Trim(m[2], "/")); ok {
				changed = true
				return m[1] + "/" + to
			}
			return s
		}
	}
	var out strings.Builder
	for i, part := range splitFences(src) {
		if i%2 == 0 { // outside code fences: examples inside them stay as written
			part = inlineLink.ReplaceAllStringFunc(part, repl(inlineLink))
			part = refLink.ReplaceAllStringFunc(part, repl(refLink))
		}
		out.WriteString(part)
	}
	return out.String(), changed
}

// linksIn lists the page ids a markdown document links to.
func linksIn(src string) []string {
	var ids []string
	mapLinks(src, func(id string) (string, bool) {
		ids = append(ids, id)
		return "", false
	})
	return ids
}

// splitFences splits markdown into alternating parts outside and inside ``` or ~~~ fences
// (even indexes are outside).
func splitFences(src string) []string {
	var parts []string
	var cur strings.Builder
	fence := ""
	for line := range strings.SplitAfterSeq(src, "\n") {
		t := strings.TrimLeft(line, " ")
		switch {
		case fence == "" && (strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~")):
			parts = append(parts, cur.String())
			cur.Reset()
			fence = t[:3]
			cur.WriteString(line)
		case fence != "" && strings.HasPrefix(t, fence):
			cur.WriteString(line)
			parts = append(parts, cur.String())
			cur.Reset()
			fence = ""
		default:
			cur.WriteString(line)
		}
	}
	return append(parts, cur.String())
}

// PageRef names a page.
type PageRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Backlinks lists the pages that link to page id, or with subtree also to any page under it.
// Pages inside the subtree itself are left out: they go wherever the subtree goes.
func (r *Repo) Backlinks(ctx context.Context, id string, subtree bool) ([]PageRef, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	hit := func(target string) bool {
		return target == id || subtree && within(target, id)
	}
	out := []PageRef{}
	err := r.walkPages(func(pid, _ string, data []byte) error {
		if hit(pid) {
			return nil
		}
		doc, _ := ParsePage(data)
		if slices.ContainsFunc(linksIn(doc.Body), hit) {
			out = append(out, PageRef{ID: pid, Title: pageTitle(doc, pid)})
		}
		return nil
	})
	return out, err
}

// rewriteLinks points links to page from, and to pages under it, at to, in every page, and
// stages the edited files. It returns how many pages changed. Caller holds r.mu.
func (r *Repo) rewriteLinks(ctx context.Context, from, to string) (int, error) {
	n := 0
	err := r.walkPages(func(_, abs string, data []byte) error {
		// The whole file, front matter included: re-rendering it would reformat fields that
		// the move has nothing to do with.
		out, changed := mapLinks(string(data), func(target string) (string, bool) {
			if target == from {
				return to, true
			}
			if rest, ok := strings.CutPrefix(target, from+"/"); ok {
				return to + "/" + rest, true
			}
			return "", false
		})
		if !changed {
			return nil
		}
		if err := os.WriteFile(abs, []byte(out), 0o644); err != nil {
			return err
		}
		rel, err := filepath.Rel(r.cfg.Workdir, abs)
		if err != nil {
			return err
		}
		n++
		return r.git(ctx, "add", "--", filepath.ToSlash(rel))
	})
	return n, err
}

// walkPages calls fn for every page file under the content dir, skipping attachment folders
// and dotfiles, and stops at the first error fn returns.
func (r *Repo) walkPages(fn func(id, abs string, data []byte) error) error {
	root := filepath.Join(r.cfg.Workdir, r.cfg.ContentDir)
	return filepath.WalkDir(root, func(p string, de os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry: skip it
		}
		name := de.Name()
		if de.IsDir() {
			if p != root && (strings.HasPrefix(name, ".") || name == "assets") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		return fn(pageIDForPath(filepath.ToSlash(rel)), p, data)
	})
}

// pageIDForPath maps a markdown file path relative to the content dir to its page id.
func pageIDForPath(rel string) string {
	if rel == "_index.md" {
		return HomeID
	}
	if id, ok := strings.CutSuffix(rel, "/_index.md"); ok {
		return id
	}
	return strings.TrimSuffix(rel, ".md")
}

// pageOfFile maps a repo-relative file path to the page it belongs to: the page itself for
// its markdown file, the owning page for an attachment. ok is false for anything else.
func (r *Repo) pageOfFile(file string) (id string, ok bool) {
	rel, ok := strings.CutPrefix(file, r.cfg.ContentDir+"/")
	if !ok {
		return "", false
	}
	if strings.HasSuffix(rel, ".md") {
		return pageIDForPath(rel), true
	}
	if strings.HasPrefix(rel, "assets/") {
		return HomeID, true
	}
	if owner, _, found := strings.Cut(rel, "/assets/"); found {
		return owner, true
	}
	return "", false
}

func pageTitle(doc *PageDoc, id string) string {
	if t, ok := doc.FrontMatter["title"].(string); ok && t != "" {
		return t
	}
	return id
}
