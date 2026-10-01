package gitstore

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseAndRender(t *testing.T) {
	src := `---
title: "Hello"
weight: 3
toc: false
tags:
  - a
  - b
---

# Body

text
`
	doc, err := ParsePage([]byte(src))
	if err != nil { t.Fatal(err) }
	if doc.FrontMatter["title"] != "Hello" { t.Errorf("title: %v", doc.FrontMatter["title"]) }
	if doc.FrontMatter["weight"] != 3 { t.Errorf("weight: %v (%T)", doc.FrontMatter["weight"], doc.FrontMatter["weight"]) }
	if !strings.Contains(doc.Body, "# Body") { t.Errorf("body: %q", doc.Body) }

	// Update title only, body stays
	doc.FrontMatter["title"] = "World"
	doc.Body = "# New\n\nbody\n"
	out, err := RenderPage(doc)
	if err != nil { t.Fatal(err) }
	s := string(out)
	if !strings.Contains(s, `title: "World"`) { t.Errorf("missing title in output:\n%s", s) }
	if !strings.Contains(s, "weight: 3") { t.Errorf("lost weight:\n%s", s) }
	if !strings.Contains(s, "# New") { t.Errorf("lost body") }

	// Re-parse to confirm round trip works
	doc2, err := ParsePage(out)
	if err != nil { t.Fatal(err) }
	if doc2.FrontMatter["title"] != "World" { t.Errorf("roundtrip title: %v", doc2.FrontMatter["title"]) }
	if !strings.Contains(doc2.Body, "# New") { t.Errorf("roundtrip body: %q", doc2.Body) }
}

// Saving a page rewrites its front matter; fields the UI never touched (Hugo tags, dates)
// must come back exactly as they were parsed.
func TestRenderRoundTripsHugoFields(t *testing.T) {
	src := "---\ntitle: \"T\"\ntags:\n  - go\n  - \"wiki: tips\"\ndate: 2024-05-01T10:00:00+08:00\nday: 2024-05-02\ndraft: true\nweight: 10\nratio: 1.5\nparams:\n  toc: true\n---\n\nbody\n"
	doc, err := ParsePage([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	out, err := RenderPage(doc)
	if err != nil {
		t.Fatal(err)
	}
	doc2, err := ParsePage(out)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(doc.FrontMatter, doc2.FrontMatter) {
		t.Fatalf("front matter changed on save:\nbefore %#v\nafter  %#v\nrendered:\n%s", doc.FrontMatter, doc2.FrontMatter, out)
	}
}

// The properties panel sends every field; only the ones that changed may touch the file.
func TestMetaApply(t *testing.T) {
	fm := map[string]any{"draft": false, "tags": []any{"a"}, "date": "2024-05-01", "description": "d"}
	m := MetaOf(fm)
	m.Tags = append(m.Tags, "b")
	m.Description = ""
	m.Apply(fm)
	want := map[string]any{"draft": false, "tags": []string{"a", "b"}, "date": "2024-05-01"}
	if !reflect.DeepEqual(fm, want) {
		t.Errorf("after Apply: %#v, want %#v", fm, want)
	}
}

func TestNoFrontMatter(t *testing.T) {
	doc, err := ParsePage([]byte("# Just a heading\n\nbody\n"))
	if err != nil { t.Fatal(err) }
	if len(doc.FrontMatter) != 0 { t.Errorf("expected empty fm, got %v", doc.FrontMatter) }
	if !strings.HasPrefix(doc.Body, "# Just a heading") { t.Errorf("body: %q", doc.Body) }
}
