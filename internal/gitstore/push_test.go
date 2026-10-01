package gitstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
)

// Saves return before anything reaches origin; the push loop then delivers them, rebasing
// onto a commit that was pushed to origin from outside gitwiki in the meantime. Each save
// that changes something stays its own commit; one push just carries all of them.
func TestSavePushesInBackgroundOverExternalCommit(t *testing.T) {
	r, origin, external := saveBehindExternalCommit(t, "content/b.md")
	savePage(t, r, "mine again\n")
	savePage(t, r, "mine again\n") // no change: no commit
	if err := waitSync(t, r); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{"content/a.md": "mine again", "content/b.md": "external"} {
		if got := gitLines(t, origin, "show", "main:"+path); strings.Join(got, " ") != want {
			t.Errorf("origin %s = %q, want %q", path, got, want)
		}
	}
	if got := gitLines(t, origin, "rev-parse", "main~2")[0]; got != external {
		t.Errorf("want the two saves as two commits on top of the external one")
	}
}

// When the external commit touches the same lines, sync stops and reports instead of
// picking a side, and the working copy is left usable: no half-done rebase, save intact.
func TestPushStopsOnConflictingExternalCommit(t *testing.T) {
	r, origin, external := saveBehindExternalCommit(t, "content/a.md")
	if err := waitSync(t, r); err == nil || !strings.Contains(err.Error(), "冲突") {
		t.Fatalf("want conflict error, got %v", err)
	}
	work := r.cfg.Workdir
	if _, err := os.Stat(filepath.Join(work, ".git", "rebase-merge")); err == nil {
		t.Fatal("working copy left in the middle of a rebase")
	}
	if got := gitLines(t, work, "show", "HEAD:content/a.md"); len(got) != 1 || got[0] != "mine" {
		t.Errorf("local HEAD a.md = %q, want the saved text", got)
	}
	if got := gitLines(t, origin, "rev-parse", "main")[0]; got != external {
		t.Errorf("origin changed despite the conflict")
	}
}

// A pull fast-forwards to commits made on GitHub and reports the pages they touched, but
// leaves the working copy alone while local commits wait to be pushed.
func TestPullFastForwardsExternalCommits(t *testing.T) {
	r, origin, external := saveBehindExternalCommit(t, "content/b.md")
	if pages, err := r.pullOnce(); err != nil || pages != nil {
		t.Fatalf("pull with an unpushed save = %v, %v; want no-op", pages, err)
	}
	if err := waitSync(t, r); err != nil { // pushes the save, rebased onto the external commit
		t.Fatal(err)
	}

	seed := filepath.Join(filepath.Dir(origin), "seed")
	mustGit(t, seed, "pull", "-q", "origin", "main")
	writeFile(t, seed, "content/b.md", "external again\n")
	writeFile(t, seed, "content/c/assets/x.png", "png")
	mustGit(t, seed, "add", ".")
	mustGit(t, seed, "commit", "-m", "external edit 2")
	mustGit(t, seed, "push", "-q", "origin", "main")

	pages, err := r.pullOnce()
	if err != nil || strings.Join(pages, " ") != "b c" {
		t.Fatalf("pull = %v, %v; want pages b c", pages, err)
	}
	if got, want := gitLines(t, r.cfg.Workdir, "rev-parse", "HEAD")[0], gitLines(t, origin, "rev-parse", "main")[0]; got != want || got == external {
		t.Errorf("working copy at %s, origin at %s", got, want)
	}
}

// saveBehindExternalCommit clones origin, pushes an outside edit of externalFile to origin,
// then saves page "a" from the now-stale clone. It checks the save did not push by itself.
func saveBehindExternalCommit(t *testing.T, externalFile string) (r *Repo, origin, external string) {
	t.Helper()
	root := t.TempDir()
	origin = filepath.Join(root, "origin.git")
	seed, work := filepath.Join(root, "seed"), filepath.Join(root, "work")
	mustGit(t, root, "init", "--bare", "-b", "main", origin)
	mustGit(t, root, "clone", origin, seed)
	mustGit(t, seed, "config", "user.email", "t@t.t")
	mustGit(t, seed, "config", "user.name", "t")
	writeFile(t, seed, "content/a.md", "a\n")
	writeFile(t, seed, "content/b.md", "b\n")
	mustGit(t, seed, "add", ".")
	mustGit(t, seed, "commit", "-m", "init")
	mustGit(t, seed, "push", "origin", "main")
	mustGit(t, root, "clone", origin, work)

	writeFile(t, seed, externalFile, "external\n")
	mustGit(t, seed, "commit", "-am", "external edit")
	mustGit(t, seed, "push", "origin", "main")
	external = gitLines(t, seed, "rev-parse", "HEAD")[0]

	r = &Repo{cfg: config.Repo{Slug: "t", Workdir: work, ContentDir: "content", Branch: "main"}}
	savePage(t, r, "mine\n")
	if got := gitLines(t, origin, "rev-parse", "main")[0]; got != external {
		t.Fatalf("save pushed synchronously: origin moved to %s", got)
	}
	return r, origin, external
}

// savePage saves page "a" with body on top of the current local HEAD.
func savePage(t *testing.T, r *Repo, body string) {
	t.Helper()
	base := gitLines(t, r.cfg.Workdir, "rev-parse", "HEAD")[0]
	u := &auth.User{Login: "u", Name: "u", Email: "u@u.u"} // no token: origin stays the local path
	doc := &PageDoc{FrontMatter: map[string]any{}, Body: body}
	if _, err := r.SavePage(t.Context(), "a", doc, base, "", u); err != nil {
		t.Fatal(err)
	}
}

// waitSync starts the push loop and returns the outcome of its first attempt.
func waitSync(t *testing.T, r *Repo) error {
	t.Helper()
	synced := make(chan error, 1)
	r.startSync(func(err error) {
		select {
		case synced <- err:
		default: // later retries are not part of the test
		}
	}, func([]string) {})
	select {
	case err := <-synced:
		return err
	case <-time.After(30 * time.Second):
		t.Fatal("push loop never reported")
		return nil
	}
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
