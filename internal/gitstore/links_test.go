package gitstore

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jimyag/gitwiki/internal/auth"
)

var tester = &auth.User{Login: "u", Name: "u", Email: "u@u.u"} // no token: nothing is pushed

// Moving a page carries its children along, turns a leaf parent into a bundle, and rewrites
// links to the page and its children (not code examples or other URLs), all in one commit.
func TestMovePageRewritesLinks(t *testing.T) {
	r := setupRepo(t) // content/a.md is a leaf
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b/_index.md", "---\ntitle: \"B\"\n---\n")
	writeFile(t, dir, "content/b/c.md", "---\ntitle: \"C\"\n---\n[self](/b/c)\n")
	links := "[B](/b) and [C](/b/c#sec) and [other](/bx) and [ext](//b/c)\n\n```\n[B](/b)\n```\n\n[ref]: /b/c\n"
	writeFile(t, dir, "content/d.md", "---\ntitle: \"D\"\ntags: [\"x\"]\n---\n"+links)
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "pages")

	newID, n, err := r.MovePage(t.Context(), "b", "a", tester)
	if err != nil {
		t.Fatal(err)
	}
	if newID != "a/b" || n != 2 { // d.md, and c.md's link to itself
		t.Fatalf("MovePage = %q, %d links", newID, n)
	}
	for _, f := range []string{"content/a/_index.md", "content/a/b/_index.md", "content/a/b/c.md"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("%s missing after move", f)
		}
	}
	got, _ := os.ReadFile(filepath.Join(dir, "content/d.md"))
	want := "---\ntitle: \"D\"\ntags: [\"x\"]\n---\n" +
		"[B](/a/b) and [C](/a/b/c#sec) and [other](/bx) and [ext](//b/c)\n\n```\n[B](/b)\n```\n\n[ref]: /a/b/c\n"
	if string(got) != want {
		t.Errorf("d.md after move:\n%s\nwant:\n%s", got, want)
	}
	if st := gitLines(t, dir, "status", "--porcelain"); len(st) != 0 {
		t.Errorf("move left uncommitted changes: %q", st)
	}

	if _, _, err := r.MovePage(t.Context(), "a", "a/b", tester); !errors.Is(err, ErrBadPath) {
		t.Errorf("move into own subtree: %v", err)
	}
	writeFile(t, dir, "content/c.md", "x\n")
	if _, _, err := r.MovePage(t.Context(), "a/b/c", "", tester); !errors.Is(err, ErrExists) {
		t.Errorf("move onto an existing page: %v", err)
	}
}

func TestBacklinks(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/x.md", "---\ntitle: \"X\"\n---\nsee [a](/a)\n")
	writeFile(t, dir, "content/y.md", "see [child](/a/kid)\n\n```\n[a](/a)\n```\n")
	writeFile(t, dir, "content/a/kid.md", "back to [a](/a)\n")
	refs := func(subtree bool) string {
		got, err := r.Backlinks(t.Context(), "a", subtree)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, p := range got {
			ids = append(ids, p.ID+"="+p.Title)
		}
		return strings.Join(ids, " ")
	}
	if got := refs(false); got != "a/kid=a/kid x=X" {
		t.Errorf("backlinks(a) = %q", got)
	}
	if got := refs(true); got != "x=X y=y" {
		t.Errorf("backlinks(a, subtree) = %q", got)
	}
}
