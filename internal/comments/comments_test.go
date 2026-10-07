package comments

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
	"github.com/jimyag/gitwiki/internal/gitstore"
)

func TestMoveCarriesSavedAndPendingComments(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.CommandContext(t.Context(), "git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "test")
	git("config", "user.email", "test@example.com")
	if err := os.MkdirAll(filepath.Join(dir, "content/b"), 0o755); err != nil {
		t.Fatal(err)
	}
	for rel, data := range map[string]string{"a.md": "A\n", "b/_index.md": "B\n", "b/c.md": "C\n"} {
		if err := os.WriteFile(filepath.Join(dir, "content", rel), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("add", ".")
	git("commit", "-m", "initial pages")
	m := gitstore.NewManager(&config.Config{Repos: []config.Repo{{Slug: "test", Workdir: dir, ContentDir: "content", Branch: "main"}}})
	r := m.Get("test")
	s := New(m)
	u := &auth.User{Login: "test", Email: "test@example.com"}
	for _, id := range []string{"b", "b/c"} {
		if _, err := s.Add(r, id, "saved", true, &TextAnchor{Quote: "B"}, u); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Add(r, id, "pending", false, nil, u); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := s.MovePage(t.Context(), r, "b", "a", u); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a/b", "a/b/c"} {
		list, err := s.List(r, id)
		if err != nil || len(list) != 2 {
			t.Fatalf("comments(%s) = %v, %v", id, list, err)
		}
		if list[0].Text != "saved" || list[0].Anchor == nil || list[1].Text != "pending" {
			t.Fatalf("comments changed: %+v", list)
		}
	}
	if _, err := s.Add(r, "b", "late comment", true, nil, u); !errors.Is(err, gitstore.ErrNotFound) {
		t.Fatalf("late comment = %v", err)
	}
	if _, _, err := s.MovePage(t.Context(), r, "a/b", "", u); err != nil {
		t.Fatal(err)
	}
	if list, err := s.List(r, "b/c"); err != nil || len(list) != 2 {
		t.Fatalf("comments after moving back = %v, %v", list, err)
	}
}
