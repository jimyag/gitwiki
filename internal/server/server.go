package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"regexp"
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

	// Reading needs read access to the GitHub repo; changing anything needs push access.
	s.mux.HandleFunc("GET /api/repos/{slug}/pages", s.read(s.pageTree))
	s.mux.HandleFunc("GET /api/repos/{slug}/page", s.read(s.readPage))
	s.mux.HandleFunc("GET /api/repos/{slug}/history", s.read(s.pageHistory))
	s.mux.HandleFunc("GET /api/repos/{slug}/revision", s.read(s.readRevision))
	s.mux.HandleFunc("GET /api/repos/{slug}/recent", s.read(s.recentChanges))
	s.mux.HandleFunc("GET /api/repos/{slug}/backlinks", s.read(s.backlinks))
	s.mux.HandleFunc("GET /api/repos/{slug}/search", s.read(s.searchPages))
	s.mux.HandleFunc("GET /api/repos/{slug}/assets", s.read(s.listAssets))
	s.mux.HandleFunc("GET /api/repos/{slug}/asset", s.read(s.readAsset))

	s.mux.HandleFunc("PUT /api/repos/{slug}/page", s.write(s.savePage))
	s.mux.HandleFunc("POST /api/repos/{slug}/page", s.write(s.createPage))
	s.mux.HandleFunc("DELETE /api/repos/{slug}/page", s.write(s.deletePage))
	s.mux.HandleFunc("PATCH /api/repos/{slug}/page", s.write(s.retitlePage))
	s.mux.HandleFunc("POST /api/repos/{slug}/move", s.write(s.movePage))
	s.mux.HandleFunc("POST /api/repos/{slug}/restore", s.write(s.restorePage))
	s.mux.HandleFunc("POST /api/repos/{slug}/order", s.write(s.reorderPages))
	s.mux.HandleFunc("POST /api/repos/{slug}/assets", s.write(s.uploadAsset))
	s.mux.HandleFunc("DELETE /api/repos/{slug}/asset", s.write(s.deleteAsset))

	s.mux.HandleFunc("GET /ws", s.presence)

	// React SPA: serve dist/index.html for any non-API GET.
	s.mux.HandleFunc("GET /", s.spa)
}

func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if s.static == nil {
		http.Error(w, "static assets not embedded; run task build", http.StatusServiceUnavailable)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	_, err := fs.Stat(s.static, p)
	switch {
	case strings.HasPrefix(p, "assets/") && err == nil:
		// Vite puts a content hash in every file name under assets/.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	case strings.HasPrefix(p, "assets/"), strings.HasPrefix(p, "api/"):
		// A stale chunk name must 404: falling back to index.html would get cached as the chunk.
		// Unknown API paths 404 too, instead of answering JSON clients with HTML.
		http.NotFound(w, r)
		return
	default:
		w.Header().Set("Cache-Control", "no-cache")
		if err != nil {
			// SPA fallback: always return index.html for unknown non-API GETs.
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
	}
	http.FileServer(http.FS(s.static)).ServeHTTP(w, r)
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
	// Repos ride along so the client needs one round trip instead of two before the tree.
	writeJSON(w, map[string]any{
		"user":  map[string]string{"login": u.Login, "name": u.Name, "email": u.Email},
		"repos": s.visibleRepos(r.Context(), u),
	})
}

type repoView struct {
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	CanWrite bool   `json:"can_write"`
	SiteURL  string `json:"site_url,omitempty"`
}

// visibleRepos lists the configured repos the user can read, and whether they may edit them.
func (s *Server) visibleRepos(ctx context.Context, u *auth.User) []repoView {
	out := make([]repoView, 0, len(s.cfg.Repos))
	for _, rc := range s.cfg.Repos {
		a, err := s.auth.Access(ctx, u, rc.Github)
		if err != nil {
			log.Printf("access %s: %v", rc.Github, err)
			continue
		}
		if a.Read {
			out = append(out, repoView{Slug: rc.Slug, Title: rc.Title, CanWrite: a.Write, SiteURL: rc.SiteURL})
		}
	}
	return out
}

// authorize lets through users who can read the repo on GitHub, or push to it for a write.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request, u *auth.User, rc *config.Repo, write bool) bool {
	a, err := s.auth.Access(r.Context(), u, rc.Github)
	if err != nil {
		http.Error(w, "permission check failed: "+err.Error(), http.StatusBadGateway)
		return false
	}
	if !a.Read || write && !a.Write {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// call is one request against the {slug} repo by a user who may make it.
type call struct {
	slug string
	repo *gitstore.Repo
	user *auth.User
}

type repoHandler func(w http.ResponseWriter, r *http.Request, c *call)

func (s *Server) read(h repoHandler) http.HandlerFunc  { return s.withRepo(false, h) }
func (s *Server) write(h repoHandler) http.HandlerFunc { return s.withRepo(true, h) }

func (s *Server) withRepo(write bool, h repoHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := s.auth.CurrentUser(r)
		if u == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		slug := r.PathValue("slug")
		rc := s.cfg.FindRepo(slug)
		if rc == nil {
			http.Error(w, "repo not found", http.StatusNotFound)
			return
		}
		if !s.authorize(w, r, u, rc, write) {
			return
		}
		rr := s.git.Get(slug)
		if rr == nil {
			http.Error(w, "repo not initialized", http.StatusInternalServerError)
			return
		}
		if err := rr.EnsureCloned(r.Context(), u.Token); err != nil {
			http.Error(w, "clone failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		h(w, r, &call{slug: slug, repo: rr, user: u})
	}
}

// fail answers err with the status code that tells the client what went wrong.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gitstore.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, gitstore.ErrExists):
		http.Error(w, "目标位置已有同名页面", http.StatusConflict)
	case errors.Is(err, gitstore.ErrBadPath):
		http.Error(w, "invalid path", http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	rc := s.cfg.FindRepo(r.URL.Query().Get("repo"))
	if rc == nil {
		http.Error(w, "repo not found", http.StatusNotFound)
		return
	}
	if !s.authorize(w, r, u, rc, false) {
		return
	}
	s.present.ServeHTTP(w, r)
}

func (s *Server) pageTree(w http.ResponseWriter, r *http.Request, c *call) {
	tree, err := c.repo.PageTree(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, tree)
}

func (s *Server) readPage(w http.ResponseWriter, r *http.Request, c *call) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	f, isBundle, err := c.repo.ReadPage(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{
		"id":              id,
		"title":           f.Title,
		"body":            f.Body,
		"meta":            gitstore.MetaOf(f.RawMeta),
		"base_sha":        f.BaseSHA,
		"is_bundle":       isBundle,
		"last_author":     f.LastAuthor,
		"last_commit_sha": f.LastCommitSHA,
		"last_commit_at":  f.LastCommitAt,
	})
}

func (s *Server) pageHistory(w http.ResponseWriter, r *http.Request, c *call) {
	revs, err := c.repo.History(r.Context(), r.URL.Query().Get("id"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, revs)
}

// readRevision returns a page as of one of its History commits.
func (s *Server) readRevision(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	doc, err := c.repo.PageAt(r.Context(), q.Get("id"), q.Get("sha"))
	if err != nil {
		fail(w, err)
		return
	}
	title, _ := doc.FrontMatter["title"].(string)
	writeJSON(w, map[string]any{"title": title, "body": doc.Body, "meta": gitstore.MetaOf(doc.FrontMatter)})
}

func (s *Server) recentChanges(w http.ResponseWriter, r *http.Request, c *call) {
	changes, err := c.repo.RecentChanges(r.Context(), 30)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, changes)
}

func (s *Server) backlinks(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	refs, err := c.repo.Backlinks(r.Context(), q.Get("id"), q.Get("subtree") == "1")
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, refs)
}

type saveReq struct {
	ID      string         `json:"id"`
	Title   string         `json:"title"`
	Body    string         `json:"body"`
	Meta    *gitstore.Meta `json:"meta"` // nil: leave tags, draft, description and date as they are
	BaseSHA string         `json:"base_sha"`
	Message string         `json:"message"`
}

func (s *Server) savePage(w http.ResponseWriter, r *http.Request, c *call) {
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
	existing, _, rerr := c.repo.ReadPage(r.Context(), req.ID)
	var doc *gitstore.PageDoc
	if rerr == nil {
		doc = &gitstore.PageDoc{FrontMatter: existing.RawMeta, Body: req.Body}
	} else if errors.Is(rerr, gitstore.ErrNotFound) {
		doc = &gitstore.PageDoc{FrontMatter: map[string]any{}, Body: req.Body}
	} else {
		fail(w, rerr)
		return
	}
	// Title is always overwritable from the UI.
	if req.Title != "" {
		doc.FrontMatter["title"] = req.Title
	}
	if req.Meta != nil {
		req.Meta.Apply(doc.FrontMatter)
	}
	sha, err := c.repo.SavePage(r.Context(), req.ID, doc, req.BaseSHA, req.Message, c.user)
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
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, req.ID)
	writeJSON(w, map[string]string{"commit_sha": sha})
}

type createReq struct {
	ParentID string `json:"parent_id"`
	Title    string `json:"title"`
}

func (s *Server) createPage(w http.ResponseWriter, r *http.Request, c *call) {
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.Title == "" {
		http.Error(w, "title required", http.StatusBadRequest)
		return
	}
	id, err := c.repo.CreatePage(r.Context(), req.ParentID, req.Title, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, id)
	writeJSON(w, map[string]string{"id": id})
}

func (s *Server) deletePage(w http.ResponseWriter, r *http.Request, c *call) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	if err := c.repo.DeletePage(r.Context(), id, c.user); err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, id)
	writeJSON(w, map[string]string{"status": "deleted"})
}

type moveReq struct {
	ID       string `json:"id"`
	ParentID string `json:"parent_id"` // "" for the top level
}

func (s *Server) movePage(w http.ResponseWriter, r *http.Request, c *call) {
	var req moveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	newID, links, err := c.repo.MovePage(r.Context(), req.ID, req.ParentID, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, req.ID, newID)
	writeJSON(w, map[string]any{"id": newID, "links_updated": links})
}

type restoreReq struct {
	ID  string `json:"id"`
	SHA string `json:"sha"` // the commit that deleted the page
}

func (s *Server) restorePage(w http.ResponseWriter, r *http.Request, c *call) {
	var req restoreReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := c.repo.RestorePage(r.Context(), req.ID, req.SHA, c.user); err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, req.ID)
	writeJSON(w, map[string]string{"id": req.ID})
}

type retitleReq struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func (s *Server) retitlePage(w http.ResponseWriter, r *http.Request, c *call) {
	var req retitleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.ID == "" || req.Title == "" {
		http.Error(w, "id and title required", http.StatusBadRequest)
		return
	}
	sha, err := c.repo.UpdateTitle(r.Context(), req.ID, req.Title, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, req.ID)
	writeJSON(w, map[string]string{"status": "renamed", "id": req.ID, "commit_sha": sha})
}

type reorderReq struct {
	ParentID string   `json:"parent_id"`
	Ordered  []string `json:"ordered_ids"`
}

func (s *Server) reorderPages(w http.ResponseWriter, r *http.Request, c *call) {
	var req reorderReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if err := c.repo.OrderChildren(r.Context(), req.ParentID, req.Ordered, c.user); err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login)
	writeJSON(w, map[string]string{"status": "reordered"})
}

func (s *Server) searchPages(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		writeJSON(w, []any{})
		return
	}
	hits, err := c.repo.Search(r.Context(), q)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, hits)
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request, c *call) {
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
	relPath, err := c.repo.SaveAsset(r.Context(), pageID, hdr.Filename, f, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]string{"path": relPath})
}

func (s *Server) deleteAsset(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	if err := c.repo.DeleteAsset(r.Context(), q.Get("page_id"), q.Get("name"), c.user); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// listAssets returns files under the page's assets dir.
func (s *Server) listAssets(w http.ResponseWriter, r *http.Request, c *call) {
	pageID := r.URL.Query().Get("page_id")
	if pageID == "" {
		http.Error(w, "page_id required", http.StatusBadRequest)
		return
	}
	list, err := c.repo.ListAssets(r.Context(), pageID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, list)
}

// hashedAsset matches names produced by SaveAsset: "<base>-<content sha1 prefix>[.ext]",
// 12 hex chars since d38cd76 and 8 before it.
var hashedAsset = regexp.MustCompile(`-[0-9a-f]{8}([0-9a-f]{4})?(\.[A-Za-z0-9]+)?$`)

// readAsset serves a single asset file. Path is "<page_id>/assets/<filename>".
func (s *Server) readAsset(w http.ResponseWriter, r *http.Request, c *call) {
	pageID := r.URL.Query().Get("page_id")
	name := r.URL.Query().Get("name")
	if pageID == "" || name == "" {
		http.Error(w, "page_id and name required", http.StatusBadRequest)
		return
	}
	path, err := c.repo.AssetPath(pageID, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if hashedAsset.MatchString(name) {
		// Content-addressed name: the bytes behind this URL never change.
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		// Added outside the app (e.g. via git) and may be replaced in place: revalidate via Last-Modified.
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	// Uploads are user content: opened directly (e.g. an SVG with a script) they must not run on this origin.
	w.Header().Set("Content-Security-Policy", "sandbox")
	http.ServeFile(w, r, path)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
