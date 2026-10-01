package gitstore

import (
	"maps"
	"os"
	"path/filepath"
	"testing"
)

// Only changes to a page's text count: reordering, becoming the folder a page was moved into,
// and having links rewritten by a move (shown as such) are not edits of the page.
func TestChangesLeaveOutHousekeeping(t *testing.T) {
	r := setupRepo(t) // content/a.md, committed as "init"
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/b.md", "---\ntitle: \"B\"\n---\n")
	writeFile(t, dir, "content/d.md", "see [b](/b)\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "pages")
	if err := r.OrderChildren(t.Context(), "", []string{"d", "b", "a"}, tester); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.MovePage(t.Context(), "b", "a", tester); err != nil {
		t.Fatal(err)
	}

	changes, err := r.RecentChanges(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, c := range changes {
		got[c.ID] = c.Message
	}
	if want := map[string]string{"a/b": "wiki: move b → a/b", "a": "init", "d": "pages"}; !maps.Equal(got, want) {
		t.Errorf("recent changes = %v, want %v", got, want)
	}
	if revs, _ := r.History(t.Context(), "d"); len(revs) != 2 || !revs[0].LinksOnly || revs[1].Message != "pages" {
		t.Errorf("history(d) = %+v, want the link rewrite, then the creation", revs)
	}
	if revs, _ := r.History(t.Context(), "a"); len(revs) != 1 || revs[0].Message != "init" {
		t.Errorf("history(a) = %+v, want only its creation", revs)
	}
}

// Deleting a page takes its children and attachments in one commit; the deletion shows up
// once in recent changes (children folded in) and restoring it brings everything back.
func TestDeleteRestoreAndRecentChanges(t *testing.T) {
	r := setupRepo(t)
	dir := r.cfg.Workdir
	writeFile(t, dir, "content/p/_index.md", "---\ntitle: \"P\"\n---\nv1\n")
	writeFile(t, dir, "content/p/q.md", "---\ntitle: \"Q\"\n---\n")
	writeFile(t, dir, "content/p/assets/x.png", "png")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "p")
	writeFile(t, dir, "content/p/_index.md", "---\ntitle: \"P\"\n---\nv2\n")
	mustGit(t, dir, "commit", "-am", "p v2")

	revs, err := r.History(t.Context(), "p")
	if err != nil || len(revs) != 2 {
		t.Fatalf("History = %v, %v", revs, err)
	}
	if doc, err := r.PageAt(t.Context(), "p", revs[1].SHA); err != nil || doc.Body != "v1\n" {
		t.Fatalf("PageAt(first) = %v, %v", doc, err)
	}

	if err := r.DeletePage(t.Context(), "p", tester); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "content/p")); !os.IsNotExist(err) {
		t.Fatalf("content/p still there: %v", err)
	}
	changes, err := r.RecentChanges(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 || changes[0].ID != "p" || !changes[0].Deleted || changes[0].Title != "P" || changes[1].ID != "a" {
		t.Fatalf("recent changes after delete = %+v", changes)
	}

	if err := r.RestorePage(t.Context(), "p", changes[0].SHA, tester); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"content/p/_index.md", "content/p/q.md", "content/p/assets/x.png"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("%s not restored", f)
		}
	}
	if st := gitLines(t, dir, "status", "--porcelain"); len(st) != 0 {
		t.Errorf("restore left uncommitted changes: %q", st)
	}
	changes, _ = r.RecentChanges(t.Context(), 10)
	if changes[0].ID != "p" || changes[0].Deleted {
		t.Errorf("after restore = %+v", changes[0])
	}
	// The deletion is not a version; every listed version can be read back.
	revs, err = r.History(t.Context(), "p")
	if err != nil || len(revs) != 3 {
		t.Fatalf("History after restore = %v, %v", revs, err)
	}
	for _, rev := range revs {
		if _, err := r.PageAt(t.Context(), "p", rev.SHA); err != nil {
			t.Errorf("PageAt(%s %q): %v", rev.SHA[:7], rev.Message, err)
		}
	}
	if err := r.RestorePage(t.Context(), "p", changes[0].SHA, tester); err != ErrExists {
		t.Errorf("restoring a page that exists: %v", err)
	}
}
