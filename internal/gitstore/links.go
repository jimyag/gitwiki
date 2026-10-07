package gitstore

import (
	"context"
	"net/url"
	"os"
	"path"
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
	inlineLink = regexp.MustCompile(`\]\(\s*(<[^>\n]+>|(?:\\.|[^\s()\\]|\([^\s()]*\))+)`)
	refLink    = regexp.MustCompile(`(?m)^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]+>|[^\s]+)`)
	htmlTag    = regexp.MustCompile(`(?is)<[a-z][^>]*>`)
	htmlURL    = regexp.MustCompile(`(?i)\s(?:href|src|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	hugoRef    = regexp.MustCompile(`(?s)\{\{[<%]\s*(?:ref|relref)\s+.*?[>%]\}\}`)
	hugoPath   = regexp.MustCompile("(?:\\bpath\\s*=\\s*|^\\s*)(\"[^\"]*\"|'[^']*'|`[^`]*`)")
	codeSpan   = regexp.MustCompile("`+")
)

func splitLinkSuffix(s string) (string, string) {
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		return s[:i], s[i:]
	}
	return s, ""
}

// mapReferences edits only destination tokens, leaving formatting and code examples intact.
func mapReferences(src string, fn func(string, bool) string) (string, bool) {
	mapToken := func(re *regexp.Regexp, s string, hugo bool) string {
		return re.ReplaceAllStringFunc(s, func(token string) string {
			m := re.FindStringSubmatchIndex(token)
			start, end := m[2], m[3]
			if strings.ContainsAny(token[start:start+1], "\"'`<") {
				start++
				end--
			}
			return token[:start] + fn(token[start:end], hugo) + token[end:]
		})
	}
	mapText := func(s string) string {
		s = mapToken(inlineLink, s, false)
		s = mapToken(refLink, s, false)
		s = htmlTag.ReplaceAllStringFunc(s, func(tag string) string { return mapToken(htmlURL, tag, false) })
		return hugoRef.ReplaceAllStringFunc(s, func(ref string) string {
			i := strings.Index(ref, "ref") + len("ref")
			return ref[:i] + mapToken(hugoPath, ref[i:], true)
		})
	}
	var out strings.Builder
	for i, part := range splitFences(src) {
		if i%2 == 0 {
			// Match the closing run exactly: a single backtick can live inside ``code``.
			for {
				m := codeSpan.FindStringIndex(part)
				atom := hugoRef.FindStringIndex(part)
				if tag := htmlTag.FindStringIndex(part); tag != nil && (atom == nil || tag[0] < atom[0]) {
					atom = tag
				}
				if atom != nil && (m == nil || atom[0] < m[0]) {
					out.WriteString(mapText(part[:atom[1]]))
					part = part[atom[1]:]
					continue
				}
				if m == nil {
					break
				}
				end := -1
				for _, close := range codeSpan.FindAllStringIndex(part[m[1]:], -1) {
					if close[1]-close[0] == m[1]-m[0] {
						end = m[1] + close[1]
						break
					}
				}
				if end < 0 {
					break
				}
				out.WriteString(mapText(part[:m[0]]))
				out.WriteString(part[m[0]:end])
				part = part[end:]
			}
			part = mapText(part)
		}
		out.WriteString(part)
	}
	result := out.String()
	return result, result != src
}

// rewritePageReferences resolves relative links against the original file location, then
// rebases them against its new location. Hugo's non-dot ref paths are content-root relative.
func rewritePageReferences(src, oldFile, newFile, from, to string) (string, bool) {
	return mapReferences(src, func(target string, hugo bool) string {
		p, suffix := splitLinkSuffix(target)
		if p == "" || strings.HasPrefix(p, "//") || strings.Contains(p, ":") || strings.Contains(p, "{{") {
			return target
		}
		decoded, err := url.PathUnescape(p)
		if err != nil {
			return target
		}
		absolute := strings.HasPrefix(decoded, "/")
		base := path.Dir(oldFile)
		rootRelative := hugo && !strings.HasPrefix(decoded, ".")
		if absolute || rootRelative {
			base = ""
		}
		resolved := strings.TrimPrefix(path.Clean(path.Join("/", base, decoded)), "/")
		replacement := resolved
		if resolved == from || strings.HasPrefix(resolved, from+"/") || resolved == from+".md" {
			replacement = to + strings.TrimPrefix(resolved, from)
		}
		if replacement == resolved && (oldFile == newFile || absolute || rootRelative) {
			return target
		}
		if absolute {
			replacement = "/" + replacement
		} else if !rootRelative {
			rel, err := filepath.Rel(filepath.FromSlash(path.Dir(newFile)), filepath.FromSlash(replacement))
			if err != nil {
				return target
			}
			replacement = filepath.ToSlash(rel)
			if strings.HasPrefix(p, "./") && !strings.HasPrefix(replacement, ".") {
				replacement = "./" + replacement
			}
		}
		if strings.HasSuffix(p, "/") {
			replacement += "/"
		}
		if strings.Contains(p, "%") {
			replacement = (&url.URL{Path: replacement}).EscapedPath()
		}
		return replacement + suffix
	})
}

// linksIn lists the page ids a markdown document links to.
func linksIn(src, file string) []string {
	var ids []string
	mapReferences(src, func(target string, hugo bool) string {
		p, _ := splitLinkSuffix(target)
		if p == "" || strings.HasPrefix(p, "//") || strings.Contains(p, ":") || strings.Contains(p, "{{") {
			return target
		}
		decoded, err := url.PathUnescape(p)
		if err != nil {
			return target
		}
		base := path.Dir(file)
		if strings.HasPrefix(decoded, "/") || hugo && !strings.HasPrefix(decoded, ".") {
			base = ""
		}
		id := strings.TrimPrefix(path.Clean(path.Join("/", base, decoded)), "/")
		if owner, _, ok := strings.Cut(id, "/assets/"); ok {
			id = owner
		}
		id = strings.TrimSuffix(strings.TrimSuffix(id, ".md"), "/_index")
		if id == "" {
			id = HomeID
		}
		ids = append(ids, id)
		return target
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
		run := ""
		if len(t) > 0 && (t[0] == '`' || t[0] == '~') {
			n := 0
			for n < len(t) && t[n] == t[0] {
				n++
			}
			run = t[:n]
		}
		switch {
		case fence == "" && len(line)-len(t) <= 3 && len(run) >= 3:
			parts = append(parts, cur.String())
			cur.Reset()
			fence = run
			cur.WriteString(line)
		case fence != "" && len(line)-len(t) <= 3 && strings.HasPrefix(run, fence) && strings.TrimSpace(t[len(run):]) == "":
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
	err := r.walkPages(func(pid, abs string, data []byte) error {
		if hit(pid) {
			return nil
		}
		doc, _ := ParsePage(data)
		file, err := filepath.Rel(filepath.Join(r.cfg.Workdir, r.cfg.ContentDir), abs)
		if err != nil {
			return err
		}
		if hit(MetaOf(doc.FrontMatter).ReplacedBy) || slices.ContainsFunc(linksIn(doc.Body, filepath.ToSlash(file)), hit) {
			out = append(out, PageRef{ID: pid, Title: pageTitle(doc, pid)})
		}
		return nil
	})
	return out, err
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
