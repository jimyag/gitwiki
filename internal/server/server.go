package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"strings"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
	"github.com/jimyag/gitwiki/internal/gitstore"
	"github.com/jimyag/gitwiki/internal/presence"
)

type Server struct {
	cfg     *config.Config
	auth    *auth.Store
	git     *gitstore.Manager
	present *presence.Hub
	mux     *http.ServeMux
	static  fs.FS
}

func New(cfg *config.Config, as *auth.Store, gm *gitstore.Manager, ph *presence.Hub, static fs.FS) *Server {
	s := &Server{cfg: cfg, auth: as, git: gm, present: ph, mux: http.NewServeMux(), static: static}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /login", s.auth.BeginAuth)
	s.mux.HandleFunc("GET /auth/callback", s.auth.HandleCallback)
	s.mux.HandleFunc("GET /logout", s.logout)
	s.mux.HandleFunc("GET /api/me", s.me)

	s.mux.HandleFunc("GET /api/repos", s.listRepos)
	s.mux.HandleFunc("GET /api/repos/{slug}/pages", s.pageTree)
	s.mux.HandleFunc("GET /api/repos/{slug}/page", s.readPage)
	s.mux.HandleFunc("PUT /api/repos/{slug}/page", s.savePage)
	s.mux.HandleFunc("POST /api/repos/{slug}/page", s.createPage)
	s.mux.HandleFunc("DELETE /api/repos/{slug}/page", s.deletePage)
	s.mux.HandleFunc("PATCH /api/repos/{slug}/page", s.renamePage)
	s.mux.HandleFunc("POST /api/repos/{slug}/assets", s.uploadAsset)

	s.mux.Handle("GET /ws", s.present)

	// React SPA: serve dist/index.html for any non-API GET.
	s.mux.HandleFunc("GET /", s.spa)
}

func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if s.static == nil {
		http.Error(w, "static assets not embedded; run task build", http.StatusServiceUnavailable)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if _, err := fs.Stat(s.static, p); err == nil {
		http.FileServer(http.FS(s.static)).ServeHTTP(w, r)
		return
	}
	// SPA fallback: always return index.html for unknown non-API GETs.
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	http.FileServer(http.FS(s.static)).ServeHTTP(w, r2)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "gitwiki_session", Path: "/", MaxAge: -1, HttpOnly: true})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		writeJSON(w, map[string]any{"user": nil})
		return
	}
	writeJSON(w, map[string]any{"user": map[string]string{"login": u.Login, "name": u.Name, "email": u.Email}})
}

type repoView struct {
	Slug  string `json:"slug"`
	Title string `json:"title"`
}

func (s *Server) listRepos(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	out := make([]repoView, 0, len(s.cfg.Repos))
	for _, rc := range s.cfg.Repos {
		ok, err := s.auth.CanPush(r.Context(), u, rc.Github)
		if err != nil {
			log.Printf("can-push %s: %v", rc.Github, err)
			continue
		}
		if ok {
			out = append(out, repoView{Slug: rc.Slug, Title: rc.Title})
		}
	}
	writeJSON(w, out)
}

func (s *Server) pageTree(w http.ResponseWriter, r *http.Request) {
	if s.auth.CurrentUser(r) == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, rr, ok := s.repoFor(w, r)
	if !ok {
		return
	}
	tree, err := rr.PageTree(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, tree)
}

func (s *Server) readPage(w http.ResponseWriter, r *http.Request) {
	if s.auth.CurrentUser(r) == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, rr, ok := s.repoFor(w, r)
	if !ok {
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	f, isBundle, err := rr.ReadPage(r.Context(), id)
	if errors.Is(err, gitstore.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"id":              id,
		"title":           f.Title,
		"body":            f.Body,
		"base_sha":        f.BaseSHA,
		"is_bundle":       isBundle,
		"last_author":     f.LastAuthor,
		"last_commit_sha": f.LastCommitSHA,
		"last_commit_at":  f.LastCommitAt,
	})
}

type saveReq struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	BaseSHA string `json:"base_sha"`
	Message string `json:"message"`
}

func (s *Server) savePage(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	slug, rr, ok := s.repoFor(w, r)
	if !ok {
		return
	}
	var req saveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.ID == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	// Read existing page to preserve unknown front matter fields. New pages without
	// front matter get a fresh map; we then only set title.
	existing, _, rerr := rr.ReadPage(r.Context(), req.ID)
	var doc *gitstore.PageDoc
	if rerr == nil {
		doc = &gitstore.PageDoc{FrontMatter: existing.RawMeta, Body: req.Body}
	} else if errors.Is(rerr, gitstore.ErrNotFound) {
		doc = &gitstore.PageDoc{FrontMatter: map[string]any{}, Body: req.Body}
	} else {
		http.Error(w, rerr.Error(), http.StatusInternalServerError)
		return
	}
	// Title is always overwritable from the UI.
	if req.Title != "" {
		doc.FrontMatter["title"] = req.Title
	}
	sha, err := rr.SavePage(r.Context(), req.ID, doc, req.BaseSHA, req.Message, u)
	if err != nil {
		var ce *gitstore.ConflictError
		if errors.As(err, &ce) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conflict":    true,
				"merged":      ce.Merged,
				"current_sha": ce.CurrentSHA,
				"theirs_body": ce.TheirsBody,
				"ours_body":   ce.OursBody,
				"base_body":   ce.BaseBody,
			})
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.present.BroadcastSaved(slug, req.ID, sha, u.Login)
	writeJSON(w, map[string]string{"commit_sha": sha})
}

type createReq struct {
	ParentID string `json:"parent_id"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
}

func (s *Server) createPage(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	_, rr, ok := s.repoFor(w, r)
	if !ok {
		return
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.Slug == "" {
		http.Error(w, "slug required", http.StatusBadRequest)
		return
	}
	id, err := rr.CreatePage(r.Context(), req.ParentID, req.Slug, req.Title, u)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"id": id})
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	slug, rr, ok := s.repoFor(w, r)
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, "multipart: "+err.Error(), http.StatusBadRequest)
		return
	}
	pageID := r.FormValue("page_id")
	if pageID == "" {
		http.Error(w, "page_id required", http.StatusBadRequest)
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field required", http.StatusBadRequest)
		return
	}
	defer f.Close()
	relPath, err := rr.SaveAsset(r.Context(), pageID, hdr.Filename, f, u)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.present.BroadcastSaved(slug, pageID, "", u.Login)
	writeJSON(w, map[string]string{"path": relPath})
}

func (s *Server) repoFor(w http.ResponseWriter, r *http.Request) (string, *gitstore.Repo, bool) {
	slug := r.PathValue("slug")
	rc := s.cfg.FindRepo(slug)
	if rc == nil {
		http.Error(w, "repo not found", http.StatusNotFound)
		return "", nil, false
	}
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", nil, false
	}
	grr := s.git.Get(slug)
	if grr == nil {
		http.Error(w, "repo not initialized", http.StatusInternalServerError)
		return "", nil, false
	}
	if err := grr.EnsureCloned(r.Context(), u.Token); err != nil {
		http.Error(w, "clone failed: "+err.Error(), http.StatusInternalServerError)
		return "", nil, false
	}
	return slug, grr, true
}

func (s *Server) deletePage(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil { http.Error(w, "unauthorized", http.StatusUnauthorized); return }
	slug, rr, ok := s.repoFor(w, r)
	if !ok { return }
	id := r.URL.Query().Get("id")
	if id == "" { http.Error(w, "id required", http.StatusBadRequest); return }
	if err := rr.DeletePage(r.Context(), id, u, ""); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError); return
	}
	s.present.BroadcastSaved(slug, id, "", u.Login)
	writeJSON(w, map[string]string{"status": "deleted"})
}

type renameReq struct {
	OldID string `json:"old_id"`
	NewID string `json:"new_id"`
}

func (s *Server) renamePage(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil { http.Error(w, "unauthorized", http.StatusUnauthorized); return }
	slug, rr, ok := s.repoFor(w, r)
	if !ok { return }
	var req renameReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest); return
	}
	if req.OldID == "" || req.NewID == "" {
		http.Error(w, "old_id and new_id required", http.StatusBadRequest); return
	}
	if err := rr.RenamePage(r.Context(), req.OldID, req.NewID, u); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError); return
	}
	s.present.BroadcastSaved(slug, req.OldID, "", u.Login)
	writeJSON(w, map[string]string{"status": "renamed", "id": req.NewID})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
