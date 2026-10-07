// Package comments keeps page comments out of the page body. Saved comments live in the
// repo under .comments/<page>/; pending ones only in memory until their author saves them.
package comments

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/gitstore"
)

// TextAnchor pins a comment to the passage it was written against. On top of the
// character offsets we keep the quote and its surroundings, so after the page is edited
// the anchor can be re-found in the new text.
type TextAnchor struct {
	Quote    string `json:"quote"`
	Prefix   string `json:"prefix"`
	Suffix   string `json:"suffix"`
	StartRaw int    `json:"start_raw"` // offsets into the body as of By at At
	EndRaw   int    `json:"end_raw"`
}

type Comment struct {
	ID     string      `json:"id"`
	By     string      `json:"by"`
	Name   string      `json:"name"`
	At     string      `json:"at"` // RFC3339
	Text   string      `json:"text"`
	Anchor *TextAnchor `json:"anchor,omitempty"`
}

type file struct {
	Page     string    `json:"page"`
	Comments []Comment `json:"comments"`
}

type Store struct {
	git *gitstore.Manager

	// Pending comments per repo+page, newest last. Not persisted: they vanish on restart,
	// which matches how the UI presents them as drafts until saved.
	// ponytail: comment writes and moves share one lock; use per-repo locks if contention matters.
	mu      sync.Mutex
	pending map[string][]Comment
}

func New(gm *gitstore.Manager) *Store {
	return &Store{git: gm, pending: map[string][]Comment{}}
}

// List merges the stored comments with the pending ones (which are always newer).
func (s *Store) List(repo *gitstore.Repo, pageID string) ([]Comment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out, err := s.saved(repo, pageID)
	if err != nil {
		return nil, err
	}
	out = append(out, s.pending[key(repo.Slug(), pageID)]...)
	sort.Slice(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out, nil
}

func (s *Store) saved(repo *gitstore.Repo, pageID string) ([]Comment, error) {
	data, ok, err := repo.ReadRaw(commentPath(pageID))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil // no one has commented yet
	}
	var f file
	if err := json.Unmarshal([]byte(data), &f); err != nil {
		return nil, fmt.Errorf("corrupt comments file: %w", err)
	}
	return f.Comments, nil
}

// Add stores the comment. With save it goes to the repo as the user (and shows up in
// page history); without it only lives in memory until its author saves the page.
func (s *Store) Add(repo *gitstore.Repo, pageID, text string, save bool, anchor *TextAnchor, u *auth.User) (Comment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := repo.ReadPage(context.TODO(), pageID); err != nil {
		return Comment{}, err
	}
	cm := Comment{
		ID:     randID(),
		By:     u.Login,
		Name:   displayName(u),
		At:     time.Now().UTC().Format(time.RFC3339),
		Text:   strings.TrimSpace(text),
		Anchor: anchor,
	}
	if !save {
		k := key(repo.Slug(), pageID)
		s.pending[k] = append(s.pending[k], cm)
		return cm, nil
	}
	existing, err := s.saved(repo, pageID)
	if err != nil {
		return Comment{}, err
	}
	f := file{Page: pageID, Comments: append(existing, cm)}
	data, _ := json.MarshalIndent(f, "", "  ")
	head, err := repo.HeadSHA()
	if err != nil {
		return Comment{}, err
	}
	if _, err := repo.SaveRaw(relOf(pageID), string(data), head, "wiki: comment on "+pageID, u); err != nil {
		return Comment{}, err
	}
	return cm, nil
}

// MovePage serializes comment writes with the durable move and carries pending comments
// along too. A request arriving at the old page after the move must fail instead of orphaning it.
func (s *Store) MovePage(ctx context.Context, repo *gitstore.Repo, id, parent string, u *auth.User) (string, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if parent == gitstore.HomeID {
		parent = ""
	}
	target := path.Join(parent, path.Base(id))
	if target != id {
		prefix := key(repo.Slug(), target)
		for k := range s.pending {
			if k == prefix || strings.HasPrefix(k, prefix+"/") {
				return "", 0, fmt.Errorf("%w: pending comments at %s", gitstore.ErrExists, target)
			}
		}
	}
	to, n, err := repo.MovePage(ctx, id, parent, u)
	if err != nil || to == id {
		return to, n, err
	}
	prefix := key(repo.Slug(), id)
	for k, pending := range s.pending {
		if k == prefix || strings.HasPrefix(k, prefix+"/") {
			delete(s.pending, k)
			s.pending[key(repo.Slug(), to)+strings.TrimPrefix(k, prefix)] = pending
		}
	}
	return to, n, nil
}

func commentPath(pageID string) string {
	return ".comments/" + pageID + ".json"
}

func relOf(pageID string) string { return commentPath(pageID) }

func key(slug, pageID string) string { return slug + "\x00" + pageID }

func randID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func displayName(u *auth.User) string {
	if u.Name != "" {
		return u.Name
	}
	return u.Login
}
