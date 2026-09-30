package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
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

func New(cfg *config.Config, as *auth.Store, gm *gitstore.Manager, ph *presence.Hub) *Server {
	s := &Server{cfg: cfg, auth: as, git: gm, present: ph, mux: http.NewServeMux()}
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
	s.mux.HandleFunc("POST /api/repos/{slug}/assets", s.uploadAsset)

	s.mux.Handle("GET /ws", s.present)

	// React SPA: serve dist/index.html for any non-API GET.
	s.mux.HandleFunc("GET /", s.spa)
}

func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	distRoot := "web/dist"
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	full := path.Join(distRoot, p)
	if _, err := os.Stat(full); err == nil {
		http.ServeFile(w, r, full)
		return
	}
	http.ServeFile(w, r, path.Join(distRoot, "index.html"))
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
		"id":        id,
		"content":   f.Content,
		"base_sha":  f.BaseSHA,
		"is_bundle": isBundle,
	})
}

type saveReq struct {
	ID      string `json:"id"`
	Content string `json:"content"`
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
	sha, err := rr.SavePage(r.Context(), req.ID, req.Content, req.BaseSHA, req.Message, u)
	if err != nil {
		var ce *gitstore.ConflictError
		if errors.As(err, &ce) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conflict":    true,
				"merged":      ce.Merged,
				"current_sha": ce.CurrentSHA,
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

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
