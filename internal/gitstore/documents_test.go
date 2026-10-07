package gitstore

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestTemplatesAndDeprecation(t *testing.T) {
	r := setupRepo(t)
	ctx := t.Context()
	if templates, err := r.Templates(ctx); err != nil || len(templates) != 0 {
		t.Fatalf("missing template directory: %v, %v", templates, err)
	}
	writeFile(t, r.cfg.Workdir, ".gitwiki/templates/runbook.md", "---\ntitle: 操作手册\ntags: [ops]\ndraft: true\ndescription: 使用步骤\ndeprecated: true\nreplaced_by: missing\ndate: 2020-01-01\naliases: [/old]\n---\n## 前置条件\n\n## 操作步骤\n")
	writeFile(t, r.cfg.Workdir, ".gitwiki/templates/.hidden.md", "hidden")
	mustGit(t, r.cfg.Workdir, "add", ".gitwiki")
	mustGit(t, r.cfg.Workdir, "commit", "-m", "template")
	templates, err := r.Templates(ctx)
	if err != nil || len(templates) != 1 || templates[0].Title != "操作手册" {
		t.Fatalf("templates: %+v, %v", templates, err)
	}
	id, err := r.CreatePage(ctx, "a", "实际手册", "runbook.md", tester)
	if err != nil {
		t.Fatal(err)
	}
	pc, _, err := r.ReadPage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	meta := MetaOf(pc.RawMeta)
	if pc.Title != "实际手册" || !strings.Contains(pc.Body, "## 前置条件") || !meta.Draft || !slices.Equal(meta.Tags, []string{"ops"}) || meta.Deprecated || meta.ReplacedBy != "" || meta.Date != "" || pc.RawMeta["aliases"] != nil {
		t.Fatalf("created from template: %+v, %+v", pc, meta)
	}
	if _, err := r.CreatePage(ctx, "", "bad", "../runbook.md", tester); !errors.Is(err, ErrBadPath) {
		t.Fatalf("invalid template: %v", err)
	}

	meta.Deprecated, meta.ReplacedBy = true, "a"
	meta.Apply(pc.RawMeta)
	if _, err := r.SavePage(ctx, id, &PageDoc{FrontMatter: pc.RawMeta, Body: pc.Body}, pc.BaseSHA, "", tester); err != nil {
		t.Fatal(err)
	}
	hits, err := r.Search(ctx, "实际手册", SearchOptions{})
	if err != nil || len(hits) != 1 || !hits[0].Deprecated {
		t.Fatalf("search badge: %+v %v", hits, err)
	}
	refs, err := r.Backlinks(ctx, "a", false)
	if err != nil || !slices.ContainsFunc(refs, func(p PageRef) bool { return p.ID == id }) {
		t.Fatalf("replacement backlink: %+v %v", refs, err)
	}
	writeFile(t, r.cfg.Workdir, "content/destination.md", "target parent")
	mustGit(t, r.cfg.Workdir, "add", "content/destination.md")
	mustGit(t, r.cfg.Workdir, "commit", "-m", "destination")
	if _, _, err := r.MovePage(ctx, "a", "destination", tester); err != nil {
		t.Fatal(err)
	}
	pc, _, err = r.ReadPage(ctx, "destination/"+id)
	if err != nil {
		t.Fatal(err)
	}
	meta = MetaOf(pc.RawMeta)
	if meta.ReplacedBy != "destination/a" || !meta.Deprecated {
		t.Fatalf("moved replacement: %+v", meta)
	}
	meta.ReplacedBy = pc.ID
	meta.Apply(pc.RawMeta)
	if _, err := r.SavePage(ctx, pc.ID, &PageDoc{FrontMatter: pc.RawMeta, Body: pc.Body}, pc.BaseSHA, "", tester); !errors.Is(err, ErrBadPath) {
		t.Fatalf("self replacement: %v", err)
	}
	meta.Deprecated = false
	meta.Apply(pc.RawMeta)
	if pc.RawMeta["deprecated"] != nil || pc.RawMeta["replaced_by"] != nil {
		t.Fatal("clearing deprecation must remove replacement")
	}
}

func TestHealthSnapshotScope(t *testing.T) {
	r := setupRepo(t)
	writeFile(t, r.cfg.Workdir, "content/b/_index.md", "---\ntitle: B\ndeprecated: true\n---\n[broken](/missing)")
	writeFile(t, r.cfg.Workdir, "content/b/assets/example.md", "attachment, not a page")
	writeFile(t, r.cfg.Workdir, "content/.comments/a.json", "private comment")
	writeFile(t, r.cfg.Workdir, ".gitwiki/templates/sample.md", "template, not a page")
	outside := filepath.Join(t.TempDir(), "secret.md")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(r.cfg.Workdir, "content/leak.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(r.cfg.Workdir, ".gitwiki/templates/leak.md")); err != nil {
		t.Fatal(err)
	}
	snapshot, err := r.HealthSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pages) != 2 || len(snapshot.Files) != 3 || !snapshot.Pages[1].Meta.Deprecated || !slices.Contains(snapshot.Files, "b/assets/example.md") {
		t.Fatalf("snapshot: %+v", snapshot)
	}
	templates, err := r.Templates(t.Context())
	if err != nil || len(templates) != 1 {
		t.Fatalf("template symlink must not be read: %+v %v", templates, err)
	}
}
