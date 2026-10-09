package gitstore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
)

func setupRepo(t *testing.T) *Repo {
	t.Helper()
	dir := t.TempDir()
	r := &Repo{cfg: config.Repo{
		Workdir: dir, ContentDir: "content", Branch: "main", Github: "x/y",
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

// A wiki's settings come from .gitwiki/config.yaml in the repo, with defaults for whatever is
// missing or invalid.
func TestSettings(t *testing.T) {
	r := setupRepo(t)
	r.cfg.Github, r.homepage = "o/team-docs", "https://docs.example.com"
	if s := r.Settings(); s.Title != "team-docs" || s.ReadPublic || s.SiteURL != "https://docs.example.com" || *s.StaleDays != 180 || len(s.Source) != 0 {
		t.Errorf("defaults = %+v", s)
	}
	writeFile(t, r.cfg.Workdir, ".gitwiki/config.yaml", "title: 团队文档\nread_public: true\nsite_url: https://wiki.example.com\nstale_days: 0\nsource: [markdown, word]\n")
	if s := r.Settings(); s.Title != "团队文档" || !s.ReadPublic || s.SiteURL != "https://wiki.example.com" || *s.StaleDays != 0 || !slices.Equal(s.Source, []string{"markdown"}) {
		t.Errorf("settings = %+v", s)
	}
	writeFile(t, r.cfg.Workdir, ".gitwiki/config.yaml", "title: [unclosed\n")
	if s := r.Settings(); s.Title != "team-docs" || s.ReadPublic {
		t.Errorf("unparsable file = %+v, want the defaults", s)
	}
}

// The manager sets a wiki up on first use, under GitHub's spelling of its name: on its "wiki"
// branch when it has one, else on the default branch, and on whatever branch a working copy
// already on disk has. Repos without the App are not found.
func TestManagerGet(t *testing.T) {
	data := t.TempDir()
	mustGit(t, data, "init", "-q", "-b", "outer") // data_dir inside another checkout
	disk := filepath.Join(data, "o", "disk")
	// o/split's directory exists with no copy in it: it must not take the outer branch.
	for _, dir := range []string{disk, filepath.Join(data, "o", "split")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, disk, "init", "-q", "-b", "docs")
	mustGit(t, disk, "-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "--allow-empty", "-m", "init")
	infos := map[string]auth.RepoInfo{
		"o/plain": {FullName: "o/Plain", Name: "Plain", DefaultBranch: "main"},
		"o/split": {FullName: "o/split", Name: "split", DefaultBranch: "main", WikiBranch: true},
		"o/disk":  {FullName: "o/disk", Name: "disk", DefaultBranch: "main", WikiBranch: true},
	}
	lookups := 0
	m := NewManager(data, nil, func(_ context.Context, name string) (auth.RepoInfo, error) {
		lookups++
		if info, ok := infos[strings.ToLower(name)]; ok {
			return info, nil
		}
		return auth.RepoInfo{}, auth.ErrNotInstalled
	})
	for name, want := range map[string][2]string{
		"O/plain": {"main", filepath.Join(data, "o", "Plain")},
		"o/split": {"wiki", filepath.Join(data, "o", "split")},
		"o/disk":  {"docs", disk},
	} {
		r, err := m.Get(t.Context(), name)
		if err != nil || r.cfg.Branch != want[0] || r.cfg.Workdir != want[1] {
			t.Errorf("Get(%s) = %+v, %v; want branch %s in %s", name, r, err, want[0], want[1])
		}
	}
	if r, err := m.Get(t.Context(), "o/plain"); err != nil || r.Slug() != "o/Plain" || lookups != 3 {
		t.Errorf("second Get = %v, %v after %d lookups; want the same wiki, set up once", r, err, lookups)
	}
	if _, err := m.Get(t.Context(), "o/none"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get(o/none) = %v, want ErrNotFound", err)
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

// Regression: CreatePage's leaf→bundle rename was never staged (bad git args, error ignored),
// so GitHub kept both <id>.md and <id>/_index.md while the rename sat in the working tree.
func TestPromoteToBundleStagesRename(t *testing.T) {
	r := setupRepo(t)
	abs, isBundle, err := r.diskPath("a")
	if err != nil || isBundle {
		t.Fatalf("diskPath(a) = bundle %v, err %v", isBundle, err)
	}
	if err := r.promoteToBundle(t.Context(), "a", abs); err != nil {
		t.Fatal(err)
	}
	dir := r.cfg.Workdir
	if got := gitLines(t, dir, "diff", "--cached", "--name-only", "--no-renames"); !slices.Equal(got, []string{"content/a.md", "content/a/_index.md"}) {
		t.Fatalf("staged = %q", got)
	}
	if got := gitLines(t, dir, "diff", "--name-only"); len(got) != 0 {
		t.Fatalf("unstaged leftovers: %q", got)
	}
	if got := gitLines(t, dir, "ls-files", "--others", "--exclude-standard"); len(got) != 0 {
		t.Fatalf("untracked leftovers: %q", got)
	}
}

func gitLines(t *testing.T, dir string, args ...string) []string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.Fields(string(out))
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub { return true }
	}
	return false
}
