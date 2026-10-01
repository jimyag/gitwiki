package gitstore

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// SearchHit is one page matching a query.
type SearchHit struct {
	PageID  string   `json:"page_id"`
	Title   string   `json:"title"`
	Snippet string   `json:"snippet"` // body text around the first match; empty if only the title matched
	Terms   []string `json:"terms"`   // the strings that matched, for highlighting
	score   int
}

const maxSearchHits = 50

// Search finds the pages that contain every whitespace-separated term of q in their title,
// path or body, ignoring case. Title matches rank first, then pages that mention the terms
// more often. A CJK term that matches nowhere as a whole may match as two-character words
// instead, so "协作冲突" finds "协作与冲突".
//
// ponytail: reads every page per query; build an index when wikis reach thousands of pages.
func (r *Repo) Search(ctx context.Context, q string) ([]SearchHit, error) {
	terms := strings.Fields(lower(q))
	if len(terms) == 0 || len(q) > 256 {
		return nil, ErrBadPath
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	hits := []SearchHit{}
	err := r.walkPages(func(id, _ string, data []byte) error {
		doc, _ := ParsePage(data)
		title := pageTitle(doc, id)
		if h, ok := matchPage(terms, lower(title), lower(id), doc.Body); ok {
			h.PageID, h.Title = id, title
			if lower(title) == lower(strings.TrimSpace(q)) {
				h.score += 1000
			}
			hits = append(hits, h)
		}
		return ctx.Err()
	})
	if err != nil {
		return nil, err
	}
	slices.SortStableFunc(hits, func(a, b SearchHit) int {
		return cmp.Or(cmp.Compare(b.score, a.score), cmp.Compare(a.Title, b.Title))
	})
	return hits[:min(len(hits), maxSearchHits)], nil
}

// matchPage scores one page (title and id already lowercased); ok is false unless every term
// matches somewhere. A whole-term match counts double a match of its split CJK words.
func matchPage(terms []string, title, id, body string) (h SearchHit, ok bool) {
	lbody := lower(body)
	for _, t := range terms {
		if s := wordsScore([]string{t}, title, id, lbody); s > 0 {
			h.score += 2 * s
			h.Terms = append(h.Terms, t)
			continue
		}
		words := cjkWords(t)
		s := wordsScore(words, title, id, lbody)
		if s == 0 {
			return h, false
		}
		h.score += s
		h.Terms = append(h.Terms, words...)
	}
	h.Snippet = snippet(body, h.Terms)
	return h, true
}

// wordsScore is 0 if any of words is missing from the page, else 1, plus 100 when all are in
// the title, plus how often the rarest one occurs in the body (capped at 20).
func wordsScore(words []string, title, id, lbody string) int {
	if len(words) == 0 {
		return 0
	}
	inTitle, rarest := true, -1
	for _, w := range words {
		n := strings.Count(lbody, w)
		if n == 0 && !strings.Contains(title, w) && !strings.Contains(id, w) {
			return 0
		}
		inTitle = inTitle && strings.Contains(title, w)
		if rarest < 0 || n < rarest {
			rarest = n
		}
	}
	score := 1 + min(rarest, 20)
	if inTitle {
		score += 100
	}
	return score
}

// cjkWords splits a term of three or more CJK characters into two-character words (the last
// one overlapping when the count is odd); nil for anything else.
func cjkWords(t string) []string {
	rs := []rune(t)
	if len(rs) < 3 || slices.ContainsFunc(rs, func(r rune) bool { return !isCJK(r) }) {
		return nil
	}
	var words []string
	for i := 0; i < len(rs); i += 2 {
		j := min(i+2, len(rs))
		words = append(words, string(rs[j-2:j]))
	}
	return words
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// lower lowercases rune by rune, so the result has as many runes as s and positions found in
// it can be mapped back to s.
func lower(s string) string { return strings.Map(unicode.ToLower, s) }

// snippet returns about 120 characters of body around the earliest match of any term, on one
// line, or "" if the body has none.
func snippet(body string, terms []string) string {
	lbody := lower(body)
	at := -1
	for _, t := range terms {
		if i := strings.Index(lbody, t); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at < 0 {
		return ""
	}
	rs := []rune(body)
	start := utf8.RuneCountInString(lbody[:at])
	from, to := max(start-30, 0), min(start+90, len(rs))
	s := strings.Join(strings.Fields(string(rs[from:to])), " ")
	if from > 0 {
		s = "…" + s
	}
	if to < len(rs) {
		s += "…"
	}
	return s
}
