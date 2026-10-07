package gitstore

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSearch(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/sync.md", "---\ntitle: \"保存与同步\"\n---\n保存后出现冲突怎么办？冲突会提示。冲突。\n")
	writeFile(t, dir, "content/collab.md", "---\ntitle: \"协作与冲突\"\n---\n多人同时编辑。\n")
	writeFile(t, dir, "content/go.md", "---\ntitle: \"Go\"\n---\nWriting a Wiki in Go.\n")

	search := func(q string) []SearchHit {
		hits, err := r.Search(t.Context(), q, SearchOptions{})
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

func TestSearchFilters(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/team/_index.md", "---\ntitle: Team\ntags: [ops]\n---\nneedle\n")
	writeFile(t, dir, "content/team/old.md", "---\ntitle: Old\ntags: [ops]\ndate: 2099-01-01\n---\nneedle\n")
	writeFile(t, dir, "content/team-old.md", "---\ntitle: Outside\ntags: [ops]\n---\nneedle\n")
	commitAt := func(at string) {
		t.Helper()
		mustGit(t, dir, "add", "content")
		if err := r.gitEnv(t.Context(), []string{"GIT_AUTHOR_DATE=" + at, "GIT_COMMITTER_DATE=" + at}, "commit", "-m", "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	commitAt("2020-01-01T00:00:00Z")
	writeFile(t, dir, "content/team/new.md", "---\ntitle: New\ntags: [ops]\ndraft: true\ndate: 2000-01-01\n---\nneedle\n")
	commitAt("2021-01-01T00:00:00Z")
	writeFile(t, dir, "content/team/untracked.md", "---\ntitle: Untracked\ntags: [ops]\n---\nneedle\n")
	draft, published := true, false
	after := time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tt := range []struct {
		name, query string
		opts        SearchOptions
		want        string
	}{
		{"directory boundary", "needle", SearchOptions{Directory: "team"}, "team/new team/old team team/untracked"},
		{"filter only", "", SearchOptions{Directory: "team", Tag: "ops", Draft: &draft}, "team/new"},
		{"non draft", "needle", SearchOptions{Directory: "team", Draft: &published}, "team/old team team/untracked"},
		{"commit time inclusive", "needle", SearchOptions{Directory: "team", UpdatedAfter: after}, "team/new"},
		{"after commit", "needle", SearchOptions{UpdatedAfter: after.Add(time.Second)}, ""},
		{"combined", "needle", SearchOptions{Directory: "team", Tag: "ops", Draft: &draft, UpdatedAfter: after}, "team/new"},
		{"missing tag", "needle", SearchOptions{Tag: "op"}, ""},
		{"keyword still required", "missing", SearchOptions{Draft: &draft}, ""},
		{"empty search", "", SearchOptions{}, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			hits, err := r.Search(t.Context(), tt.query, tt.opts)
			if err != nil {
				t.Fatal(err)
			}
			ids := []string{}
			for _, hit := range hits {
				ids = append(ids, hit.PageID)
				if hit.Terms == nil {
					t.Fatal("terms must serialize as an array")
				}
			}
			if got := strings.Join(ids, " "); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
	for _, opts := range []SearchOptions{{Directory: "../team"}, {Tag: strings.Repeat("x", 257)}} {
		if _, err := r.Search(t.Context(), "needle", opts); !errors.Is(err, ErrBadPath) {
			t.Fatalf("invalid filters: %v", err)
		}
	}
	for i := range maxSearchHits + 1 {
		writeFile(t, dir, fmt.Sprintf("content/many/%02d.md", i), "---\ntitle: A\n---\nneedle\n")
	}
	hits, err := r.Search(t.Context(), "needle", SearchOptions{Draft: &draft})
	if err != nil || len(hits) != 1 || hits[0].PageID != "team/new" {
		t.Fatalf("filters must run before result limit: %+v, %v", hits, err)
	}
}
