package gitstore

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type PageTemplate struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Body        string `json:"body"`
	meta        Meta
}

// Templates live outside Hugo's content tree and are read from the current Git worktree.
func (r *Repo) Templates(ctx context.Context) (_ []PageTemplate, retErr error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	root, err := os.OpenRoot(r.cfg.Workdir)
	if err != nil {
		return nil, err
	}
	defer func() { retErr = errors.Join(retErr, root.Close()) }()
	dir, err := root.OpenRoot(".gitwiki/templates")
	if errors.Is(err, os.ErrNotExist) {
		return []PageTemplate{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { retErr = errors.Join(retErr, dir.Close()) }()
	f, err := dir.Open(".")
	if err != nil {
		return nil, err
	}
	entries, err := f.ReadDir(-1)
	err = errors.Join(err, f.Close())
	if err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	out := []PageTemplate{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := entry.Name()
		if !entry.Type().IsRegular() || strings.HasPrefix(name, ".") || filepath.Ext(name) != ".md" {
			continue
		}
		file, err := dir.Open(name)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(file)
		err = errors.Join(err, file.Close())
		if err != nil {
			return nil, err
		}
		doc, _ := ParsePage(data)
		meta := MetaOf(doc.FrontMatter)
		// Dates, deprecation, aliases and URLs belong to the original page, not a new one.
		meta.Date, meta.Deprecated, meta.ReplacedBy = "", false, ""
		out = append(out, PageTemplate{ID: name, Title: pageTitle(doc, strings.TrimSuffix(name, ".md")), Description: meta.Description, Body: doc.Body, meta: meta})
	}
	return out, nil
}
