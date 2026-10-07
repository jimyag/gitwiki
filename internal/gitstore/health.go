package gitstore

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type HealthPage struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	File  string `json:"file"`
	Body  string `json:"body"`
	Meta  Meta   `json:"meta"`
}

type HealthSnapshot struct {
	Pages []HealthPage `json:"pages"`
	Files []string     `json:"files"`
}

// HealthSnapshot reads one consistent snapshot. Markdown analysis uses the browser's
// existing parser so heading IDs (including Chinese and duplicates) agree with the preview.
// ponytail: sends all page bodies on demand; batch snapshots when wikis reach thousands of pages.
func (r *Repo) HealthSnapshot(ctx context.Context) (_ *HealthSnapshot, retErr error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rootPath := filepath.Join(r.cfg.Workdir, r.cfg.ContentDir)
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer func() { retErr = errors.Join(retErr, root.Close()) }()
	out := &HealthSnapshot{Pages: []HealthPage{}, Files: []string{}}
	err = filepath.WalkDir(rootPath, func(abs string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if abs == rootPath {
			return nil
		}
		if strings.HasPrefix(entry.Name(), ".") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(rootPath, abs)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		out.Files = append(out.Files, rel)
		if !strings.HasSuffix(rel, ".md") || strings.Contains("/"+rel, "/assets/") {
			return nil
		}
		file, err := root.Open(filepath.FromSlash(rel))
		if err != nil {
			return err
		}
		data, err := io.ReadAll(file)
		err = errors.Join(err, file.Close())
		if err != nil {
			return err
		}
		doc, _ := ParsePage(data)
		id := pageIDForPath(rel)
		out.Pages = append(out.Pages, HealthPage{ID: id, Title: pageTitle(doc, id), File: rel, Body: doc.Body, Meta: MetaOf(doc.FrontMatter)})
		return nil
	})
	return out, err
}
