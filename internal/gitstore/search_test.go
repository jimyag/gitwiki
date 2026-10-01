package gitstore

import (
	"strings"
	"testing"
)

func TestSearch(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/sync.md", "---\ntitle: \"保存与同步\"\n---\n保存后出现冲突怎么办？冲突会提示。冲突。\n")
	writeFile(t, dir, "content/collab.md", "---\ntitle: \"协作与冲突\"\n---\n多人同时编辑。\n")
	writeFile(t, dir, "content/go.md", "---\ntitle: \"Go\"\n---\nWriting a Wiki in Go.\n")

	search := func(q string) []SearchHit {
		hits, err := r.Search(t.Context(), q)
		if err != nil {
			t.Fatal(err)
		}
		return hits
	}
	ids := func(hits []SearchHit) string {
		var s []string
		for _, h := range hits {
			s = append(s, h.PageID)
		}
		return strings.Join(s, " ")
	}

	if got := ids(search("冲突")); got != "collab sync" {
		t.Errorf("冲突: %q, want the title match first", got)
	}
	if hits := search("协作冲突"); ids(hits) != "collab" || strings.Join(hits[0].Terms, ",") != "协作,冲突" {
		t.Errorf("协作冲突: %+v, want a split-word match", hits)
	}
	if got := ids(search("wiki GO")); got != "go" {
		t.Errorf("wiki GO: %q", got)
	}
	if got := ids(search("wiki 冲突")); got != "" {
		t.Errorf("every term must match: %q", got)
	}
	if hits := search("提示"); len(hits) != 1 || !strings.Contains(hits[0].Snippet, "冲突会提示") {
		t.Errorf("snippet: %+v", hits)
	}
}
