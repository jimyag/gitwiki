package gitstore

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// New pages are named after their titles by one rule; a name a sibling already has, in any
// case or form, or one Hugo and gitwiki reserve, gets a number.
func TestCreatePageNamesFileAfterTitle(t *testing.T) {
	r := setupRepo(t) // content/a.md
	dir, ctx := r.cfg.Workdir, t.Context()
	writeFile(t, dir, "content/Install.md", "made outside gitwiki\n")
	writeFile(t, dir, "content/folder/x.md", "a folder without a page file\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "fixtures")
	long := strings.Repeat("长", 70)
	for _, c := range []struct{ parent, title, want string }{
		{"", "安装 指南", "安装-指南"},
		{"", "安装/指南", "安装-指南-2"},
		{"", "API 设计 (v2)！", "api-设计-v2"},
		{"", "install", "install-2"},
		{"", "Folder", "folder-2"},
		{"", "Index", "index-2"},
		{"", "assets", "assets-2"},
		{"", "🚀", "page"},
		{"", long, strings.Repeat("长", 60)},
		{"a", "子页", "a/子页"},
	} {
		id, err := r.CreatePage(ctx, c.parent, c.title, "", tester)
		if err != nil || id != c.want {
			t.Errorf("CreatePage(%q, %q) = %q, %v; want %q", c.parent, c.title, id, err, c.want)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "content/a/_index.md")); err != nil {
		t.Errorf("parent a not turned into a bundle: %v", err)
	}
}

// Pages named after Chinese titles move like any other: links to them follow, written as is or
// percent-encoded.
func TestMoveTitleNamedPage(t *testing.T) {
	r := setupRepo(t)
	dir, ctx := r.cfg.Workdir, t.Context()
	parent, err := r.CreatePage(ctx, "", "快速开始", "", tester)
	if err != nil {
		t.Fatal(err)
	}
	child, err := r.CreatePage(ctx, parent, "安装 指南", "", tester)
	if err != nil || child != "快速开始/安装-指南" {
		t.Fatalf("CreatePage = %q, %v", child, err)
	}
	enc := func(p string) string { return (&url.URL{Path: p}).EscapedPath() }
	writeFile(t, dir, "content/d.md", "[raw](/快速开始/安装-指南) [encoded]("+enc("/快速开始/安装-指南")+")\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "links")
	if to, n, err := r.MovePage(ctx, child, "", tester); err != nil || to != "安装-指南" || n != 1 {
		t.Fatalf("MovePage = %q, %d, %v", to, n, err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "content/d.md"))
	if want := "[raw](/安装-指南) [encoded](" + enc("/安装-指南") + ")\n"; string(got) != want {
		t.Errorf("d.md = %q, want %q", got, want)
	}
}

// Renaming a tag merges it into one a page already has and keeps the order; adding works on
// chosen pages only, and removing drops the key when no tag is left. One commit each.
func TestRetag(t *testing.T) {
	r := setupRepo(t)
	dir, ctx := r.cfg.Workdir, t.Context()
	writeFile(t, dir, "content/x.md", "---\ntitle: \"X\"\ntags: [\"ops\", \"db\", \"k\"]\n---\nX\n")
	writeFile(t, dir, "content/y.md", "---\ntitle: \"Y\"\ntags: \"ops\"\n---\nY\n")
	writeFile(t, dir, "content/z.md", "---\ntitle: \"Z\"\ntags: [\"db\"]\n---\nZ\n")
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-m", "pages")
	tags := func() string {
		t.Helper()
		var out []string
		for _, id := range []string{"x", "y", "z"} {
			pc, _, err := r.ReadPage(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, id+"="+strings.Join(MetaOf(pc.RawMeta).Tags, ","))
		}
		return strings.Join(out, " ")
	}
	step := func(from, to string, pages []string, wantChanged, wantTags string) {
		t.Helper()
		changed, err := r.Retag(ctx, from, to, pages, tester)
		if err != nil || strings.Join(changed, " ") != wantChanged || tags() != wantTags {
			t.Fatalf("Retag(%q, %q, %v) = %v, %v; tags %s", from, to, pages, changed, err, tags())
		}
		if st := gitLines(t, dir, "status", "--porcelain"); len(st) != 0 {
			t.Fatalf("uncommitted changes: %v", st)
		}
	}
	step("ops", "db", nil, "x y", "x=db,k y=db z=db")
	step("", "new", []string{"z"}, "z", "x=db,k y=db z=db,new")
	step("db", "", nil, "x y z", "x=k y= z=new")
	if pc, _, _ := r.ReadPage(ctx, "y"); pc.RawMeta["tags"] != nil {
		t.Errorf("empty tags kept: %v", pc.RawMeta)
	}
	for _, bad := range [][2]string{{"", "x"}, {"k", "k"}} {
		if _, err := r.Retag(ctx, bad[0], bad[1], nil, tester); !errors.Is(err, ErrBadPath) {
			t.Errorf("Retag(%q, %q) = %v", bad[0], bad[1], err)
		}
	}
}

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
