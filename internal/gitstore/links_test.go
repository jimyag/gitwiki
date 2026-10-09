package gitstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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

// A moved page and its children keep their old addresses as Hugo aliases; moving back drops
// the address the page has again, and a page with its own url keeps that.
func TestMovePageAddsAliases(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b/_index.md", "---\ntitle: \"B\"\naliases: [\"/legacy/\"]\n---\nB\n")
	writeFile(t, dir, "content/b/c.md", "C\n")
	writeFile(t, dir, "content/b/fixed.md", "---\nurl: \"/fixed/\"\n---\nF\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "pages")
	aliases := func(ids ...string) string {
		t.Helper()
		var out []string
		for _, id := range ids {
			pc, _, err := r.ReadPage(t.Context(), id)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, fmt.Sprint(pc.RawMeta["aliases"]))
		}
		return strings.Join(out, " ")
	}
	if _, n, err := r.MovePage(t.Context(), "b", "a", tester); err != nil || n != 0 {
		t.Fatalf("move = %d links, %v; aliases are not link updates", n, err)
	}
	if got := aliases("a/b", "a/b/c", "a/b/fixed"); got != "[/legacy/ /b/] [/b/c/] <nil>" {
		t.Errorf("aliases after move = %s", got)
	}
	if _, _, err := r.MovePage(t.Context(), "a/b", "", tester); err != nil {
		t.Fatal(err)
	}
	if got := aliases("b", "b/c"); got != "[/legacy/ /a/b/] [/a/b/c/]" {
		t.Errorf("aliases after moving back = %s", got)
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

func TestMovePageKeepsCommentsAndReferences(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b/_index.md", "![own](assets/x.png)\n[outside](../a)\n")
	writeFile(t, dir, "content/b/c.md", "child\n")
	writeFile(t, dir, "content/b/assets/x.png", "image")
	writeFile(t, dir, "content/.comments/b.json", `{"page":"b","comments":[{"id":"one","text":"keep me","anchor":{"quote":"own"}}]}`)
	writeFile(t, dir, "content/.comments/b/c.json", `{"page":"b/c","comments":[{"id":"two"}]}`)
	writeFile(t, dir, "content/d.md", "[page](/b/) ![image](/b/assets/x.png)\n<a href='/b/c#section'>C</a><img src=\"/b/assets/x.png\">\n[ref]: </b/c>\n[relative](b/c.md#section)\n{{< ref \"b/c.md#section\" >}}\n{{% relref path=\"/b/_index.md\" %}}\n`[example](/b)`\n```html\n<a href='/b'>example</a>\n```\n[external](https://example.com/b)\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "fixtures")
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a/b", "a/b/c"} {
		data, ok, err := r.ReadRaw(".comments/" + id + ".json")
		if err != nil || !ok || !strings.Contains(data, `"page":"`+id+`"`) {
			t.Errorf("comments(%s) = %s, %v, %v", id, data, ok, err)
		}
	}
	for _, id := range []string{"b", "b/c"} {
		if _, ok, _ := r.ReadRaw(".comments/" + id + ".json"); ok {
			t.Errorf("old comments remain for %s", id)
		}
	}
	got, _ := os.ReadFile(filepath.Join(dir, "content/d.md"))
	want := "[page](/a/b/) ![image](/a/b/assets/x.png)\n<a href='/a/b/c#section'>C</a><img src=\"/a/b/assets/x.png\">\n[ref]: </a/b/c>\n[relative](a/b/c.md#section)\n{{< ref \"a/b/c.md#section\" >}}\n{{% relref path=\"/a/b/_index.md\" %}}\n`[example](/b)`\n```html\n<a href='/b'>example</a>\n```\n[external](https://example.com/b)\n"
	if string(got) != want {
		t.Errorf("references after move:\n%s\nwant:\n%s", got, want)
	}
	page, _, err := r.ReadPage(t.Context(), "a/b")
	// The body now follows front matter: the page's old address, kept as a Hugo alias.
	if err != nil || page.Body != "\n![own](assets/x.png)\n[outside](..)\n" {
		t.Errorf("moved page = %+v, %v", page, err)
	}
	if st := gitLines(t, dir, "status", "--porcelain"); len(st) != 0 {
		t.Errorf("uncommitted changes: %v", st)
	}
}

func TestMovePageRejectsCommentCollision(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b.md", "B\n")
	writeFile(t, dir, "content/.comments/b.json", `{"page":"b","comments":[]}`)
	writeFile(t, dir, "content/.comments/a/b.json", `{"page":"a/b","comments":[{"id":"keep"}]}`)
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "fixtures")
	head, _ := r.HeadSHA()
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); !errors.Is(err, ErrExists) {
		t.Errorf("comment collision = %v, want ErrExists", err)
	}
	if after, _ := r.HeadSHA(); after != head {
		t.Error("rejected move committed changes")
	}
	if st := gitLines(t, dir, "status", "--porcelain"); len(st) != 0 {
		t.Errorf("rejected move modified files: %v", st)
	}
}

func TestMovePageRollsBackFailedCommit(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b/_index.md", "B\n")
	writeFile(t, dir, "content/b/assets/x.png", "image")
	writeFile(t, dir, "content/.comments/b.json", `{"page":"b","comments":[]}`)
	writeFile(t, dir, "content/d.md", "[B](/b)\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "fixtures")
	writeFile(t, dir, "unrelated.txt", "keep staged\n")
	mustGit(t, dir, "add", "unrelated.txt")
	writeFile(t, dir, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n")
	if err := os.Chmod(filepath.Join(dir, ".git/hooks/pre-commit"), 0o755); err != nil {
		t.Fatal(err)
	}
	head, _ := r.HeadSHA()
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err == nil {
		t.Fatal("commit failure was ignored")
	}
	if after, _ := r.HeadSHA(); after != head {
		t.Fatal("HEAD changed on failed move")
	}
	if st := gitLines(t, dir, "status", "--porcelain"); !slices.Equal(st, []string{"A", "unrelated.txt"}) {
		t.Fatalf("rollback status = %v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "content/a")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("destination remains after rollback: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, ".git/hooks/pre-commit")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.MovePage(t.Context(), "a/b", "", tester); err != nil {
		t.Fatal(err)
	}
	if st := gitLines(t, dir, "status", "--porcelain"); !slices.Equal(st, []string{"A", "unrelated.txt"}) {
		t.Fatalf("move consumed unrelated staged work: %v", st)
	}
}

func TestMovePageRejectsMalformedCommentsAndDirtyReferences(t *testing.T) {
	for _, scenario := range []string{"comments", "dirty"} {
		t.Run(scenario, func(t *testing.T) {
			r := setupRepo(t)
			dir := r.cfg.Workdir
			writeFile(t, dir, "content/b.md", "B\n")
			writeFile(t, dir, "content/d.md", "[B](/b)\n")
			if scenario == "comments" {
				writeFile(t, dir, "content/.comments/b.json", "invalid JSON")
			}
			mustGit(t, dir, "add", ".")
			mustGit(t, dir, "commit", "-m", "fixtures")
			if scenario == "dirty" {
				writeFile(t, dir, "content/d.md", "unsaved [B](/b)\n")
			}
			before := gitLines(t, dir, "status", "--porcelain")
			head, _ := r.HeadSHA()
			if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err == nil {
				t.Fatal("unsafe move succeeded")
			}
			if after, _ := r.HeadSHA(); after != head {
				t.Fatal("HEAD changed on rejected move")
			}
			if after := gitLines(t, dir, "status", "--porcelain"); !slices.Equal(after, before) {
				t.Fatalf("status = %v, want %v", after, before)
			}
		})
	}
}

func TestReferenceFormatsAndCodeExamples(t *testing.T) {
	src := "[one](/b?q=1#x)\n[ref]: /b/c.md\n{{< ref `b/c.md` >}}\n{{< relref lang=\"en\" path=\"b/c.md\" >}}\n``[B](/b) `code` ``\n````md\n```\n[B](/b)\n````\n"
	want := "[one](/a/b?q=1#x)\n[ref]: /a/b/c.md\n{{< ref `a/b/c.md` >}}\n{{< relref lang=\"en\" path=\"a/b/c.md\" >}}\n``[B](/b) `code` ``\n````md\n```\n[B](/b)\n````\n"
	if got, _ := rewritePageReferences(src, "d.md", "d.md", "b", "a/b"); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if got := linksIn("<a href='/b'>B</a>\n{{< ref \"b/c.md\" >}}\n[relative](b/c.md)\n`[example](/wrong)`", "d.md"); !slices.Equal(got, []string{"b", "b/c", "b/c"}) {
		t.Fatalf("backlinks = %v", got)
	}
}

func TestMoveRetainsHistoryWhenEveryLineChanges(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b.md", "[self](/b)\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "original")
	original, _ := r.HeadSHA()
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err != nil {
		t.Fatal(err)
	}
	revs, err := r.History(t.Context(), "a/b")
	if err != nil || len(revs) != 2 || revs[1].SHA != original {
		t.Fatalf("history after move = %+v, %v", revs, err)
	}
	if doc, err := r.PageAt(t.Context(), "a/b", original); err != nil || doc.Body != "[self](/b)\n" {
		t.Fatalf("old revision = %+v, %v", doc, err)
	}
	head, _ := r.HeadSHA()
	writeFile(t, dir, ".git/shallow", head+"\n")
	if revs, err := r.History(t.Context(), "a/b"); err != nil || len(revs) != 1 {
		t.Fatalf("shallow history = %+v, %v", revs, err)
	}
}
