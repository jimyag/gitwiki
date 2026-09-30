package gitstore

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jimyag/gitwiki/internal/config"
)

func setupRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()
	r := &Repo{cfg: config.Repo{
		Slug: "t", Workdir: dir, ContentDir: "content", Branch: "main", Github: "x/y",
	}}
	// init bare repo + clone pattern isn't needed; just init in place
	mustGit(t, dir, "init", "-b", "main")
	mustGit(t, dir, "config", "user.email", "t@t.t")
	mustGit(t, dir, "config", "user.name", "t")
	if err := os.MkdirAll(filepath.Join(dir, "content"), 0o755); err != nil { t.Fatal(err) }
	if err := os.WriteFile(filepath.Join(dir, "content", "a.md"), []byte("line1\nline2\nline3\n"), 0o644); err != nil { t.Fatal(err) }
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "init")
	return r
}

func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	full := append([]string{"-C", dir}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestResolvePath(t *testing.T) {
	r := &Repo{cfg: config.Repo{Workdir: t.TempDir(), ContentDir: "content"}}
	cases := []struct{ in string; ok bool }{
		{"a.md", true},
		{"sub/dir/a.md", true},
		{"../x.md", false},
		{"./a.md", false},               // Clean("./a.md") != "./a.md" after joining check is not triggered; reject stringcompare
		{"/etc/passwd", false},
		{"", false},
		{`..\win`, false},
		{"sub/../../x.md", false},
	}
	for _, c := range cases {
		_, err := r.resolvePath(c.in)
		if c.ok && err != nil { t.Errorf("%q should be ok, got %v", c.in, err) }
		if !c.ok && err == nil { t.Errorf("%q should be rejected", c.in) }
	}
}

func TestMerge3Clean(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	head, err := r.headSHA(ctx)
	if err != nil { t.Fatal(err) }
	base := head

	// Simulate: original file committed; then someone else advances HEAD.
	if err := os.WriteFile(filepath.Join(r.cfg.Workdir, "content", "a.md"), []byte("other change\nline2\nline3\n"), 0o644); err != nil { t.Fatal(err) }
	mustGit(t, r.cfg.Workdir, "add", ".")
	mustGit(t, r.cfg.Workdir, "commit", "-m", "other")
	newHead, _ := r.headSHA(ctx)

	// Our user edits line3 based on base. Merge should keep both changes.
	userContent := "line1\nline2\nUSER EDIT\n"
	merged, conflict, err := r.merge3(ctx, "a.md", base, newHead, userContent)
	if err != nil { t.Fatal(err) }
	if conflict { t.Fatalf("expected clean merge, got conflict:\n%s", merged) }
	t.Logf("merged:\n%s", merged)
	// Expect both "other change" (from current) and "USER EDIT" (from theirs)
	if !contains(merged, "other change") || !contains(merged, "USER EDIT") {
		t.Fatalf("merge lost lines:\n%s", merged)
	}
}

func TestMerge3Conflict(t *testing.T) {
	r := setupRepo(t)
	ctx := context.Background()
	head, _ := r.headSHA(ctx)
	base := head

	// Both edit the same line.
	if err := os.WriteFile(filepath.Join(r.cfg.Workdir, "content", "a.md"), []byte("line1\nOTHER\nline3\n"), 0o644); err != nil { t.Fatal(err) }
	mustGit(t, r.cfg.Workdir, "add", ".")
	mustGit(t, r.cfg.Workdir, "commit", "-m", "other")
	newHead, _ := r.headSHA(ctx)

	userContent := "line1\nMINE\nline3\n"
	merged, conflict, err := r.merge3(ctx, "a.md", base, newHead, userContent)
	if err != nil { t.Fatal(err) }
	if !conflict { t.Fatalf("expected conflict, got clean:\n%s", merged) }
	if !contains(merged, "<<<<<<<") || !contains(merged, "=======") || !contains(merged, ">>>>>>>") {
		t.Fatalf("missing markers:\n%s", merged)
	}
	t.Logf("conflict merged content:\n%s", merged)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub { return true }
	}
	return false
}
