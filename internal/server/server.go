package server

import (
	"cmp"
	"encoding/json"
	"errors"
	"html/template"
	"io/fs"
	"log"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/comments"
	"github.com/jimyag/gitwiki/internal/gitstore"
	"github.com/jimyag/gitwiki/internal/importer"
	"github.com/jimyag/gitwiki/internal/presence"
)

type Server struct {
	auth     *auth.Store
	git      *gitstore.Manager
	present  *presence.Hub
	mux      *http.ServeMux
	static   fs.FS
	comments *comments.Store
}

func New(as *auth.Store, gm *gitstore.Manager, ph *presence.Hub, static fs.FS) *Server {
	s := &Server{
		auth: as, git: gm, present: ph,
		mux:      http.NewServeMux(),
		static:   static,
		comments: comments.New(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /login", s.auth.BeginAuth)
	s.mux.HandleFunc("GET /auth/callback", s.auth.HandleCallback)
	s.mux.HandleFunc("GET /logout", s.logout)
	s.mux.HandleFunc("GET /api/me", s.me)
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/sync", s.write(s.syncStatus))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/sync", s.write(s.syncNow))

	// A wiki is a GitHub repo the App is installed on, addressed as owner/repo. Reading needs
	// read access to the repo (or its read_public setting); changing anything needs push access.
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/settings", s.read(s.repoSettings))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/pages", s.read(s.pageTree))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/page", s.read(s.readPage))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/history", s.read(s.pageHistory))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/revision", s.read(s.readRevision))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/recent", s.read(s.recentChanges))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/backlinks", s.read(s.backlinks))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/search", s.read(s.searchPages))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/health", s.read(s.documentHealth))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/templates", s.read(s.pageTemplates))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/assets", s.read(s.listAssets))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/asset", s.read(s.readAsset))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/comments", s.read(s.listComments))
	s.mux.HandleFunc("GET /api/repos/{owner}/{repo}/trash", s.read(s.trash))

	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/comments", s.write(s.postComment))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/import", s.write(s.importPage))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/copy", s.write(s.copyPage))

	s.mux.HandleFunc("PUT /api/repos/{owner}/{repo}/page", s.write(s.savePage))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/page", s.write(s.createPage))
	s.mux.HandleFunc("DELETE /api/repos/{owner}/{repo}/page", s.write(s.deletePage))
	s.mux.HandleFunc("PATCH /api/repos/{owner}/{repo}/page", s.write(s.retitlePage))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/move", s.write(s.movePage))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/restore", s.write(s.restorePage))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/order", s.write(s.reorderPages))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/tags", s.write(s.retag))
	s.mux.HandleFunc("POST /api/repos/{owner}/{repo}/assets", s.write(s.uploadAsset))
	s.mux.HandleFunc("DELETE /api/repos/{owner}/{repo}/asset", s.write(s.deleteAsset))

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
	// Pretty URLs: /<owner>/<repo>/<page>.md shows the source, .pdf prints it (the home page:
	// /<owner>/<repo>.md). Both are a read on the page API with a mode flag.
	if strings.HasSuffix(p, ".md") || strings.HasSuffix(p, ".pdf") {
		parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(p, ".md"), ".pdf"), "/")
		if len(parts) >= 2 && parts[0] != "" && parts[1] != "" {
			mode := "md"
			if strings.HasSuffix(p, ".pdf") {
				mode = "print"
			}
			r2 := r.Clone(r.Context())
			q := r2.URL.Query()
			q.Set("id", cmp.Or(strings.Join(parts[2:], "/"), gitstore.HomeID))
			q.Set("mode", mode)
			r2.URL.RawQuery = q.Encode()
			if c, ok := s.open(w, r2, parts[0]+"/"+parts[1], false); ok {
				s.readPage(w, r2, c)
			}
			return
		}
	}
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
	auth.ClearSession(w)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) syncStatus(w http.ResponseWriter, r *http.Request, c *call) {
	status, err := c.repo.Status(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, status)
}

func (s *Server) syncNow(w http.ResponseWriter, r *http.Request, c *call) {
	c.repo.RequestSync()
	s.syncStatus(w, r, c)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u := s.auth.CurrentUser(r)
	if u == nil {
		writeJSON(w, map[string]any{"user": nil})
		return
	}
	list, err := s.auth.Repos(r.Context(), u)
	if errors.Is(err, auth.ErrUnauthorized) {
		auth.ClearSession(w)
		writeJSON(w, map[string]any{"user": nil})
		return
	}
	if err != nil { // the user is still logged in; the list comes back on the next load
		log.Printf("list wikis: %v", err)
	}
	// The wikis ride along so the client needs one round trip instead of two before the tree:
	// the repos the App is installed on that this user can read. Others open by URL.
	repos := make([]repoView, 0, len(list))
	for _, rp := range list {
		if rp.Permissions.Pull || rp.Permissions.Push {
			repos = append(repos, repoView{Slug: rp.FullName, Title: rp.Name, CanWrite: rp.Permissions.Push})
		}
	}
	writeJSON(w, map[string]any{
		"user":  map[string]string{"login": u.Login, "name": u.Name, "email": u.Email},
		"repos": repos,
	})
}

type repoView struct {
	Slug     string `json:"slug"` // "owner/repo"
	Title    string `json:"title"`
	CanWrite bool   `json:"can_write"`
}

func (s *Server) repoSettings(w http.ResponseWriter, r *http.Request, c *call) {
	writeJSON(w, c.repo.Settings())
}

// call is one request against a wiki by a user who may make it.
type call struct {
	slug string // the wiki's "owner/repo", as GitHub spells it
	repo *gitstore.Repo
	user *auth.User // nil when the wiki is read_public and the request is anonymous
}

type repoHandler func(w http.ResponseWriter, r *http.Request, c *call)

func (s *Server) read(h repoHandler) http.HandlerFunc  { return s.withRepo(false, h) }
func (s *Server) write(h repoHandler) http.HandlerFunc { return s.withRepo(true, h) }

func (s *Server) withRepo(write bool, h repoHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c, ok := s.open(w, r, r.PathValue("owner")+"/"+r.PathValue("repo"), write); ok {
			h(w, r, c)
		}
	}
}

// open decides whether this request may read (or, with write, change) wiki name, answering it
// when not, and gets the wiki's working copy ready. People may do what their GitHub
// permission on the repo allows; reading is also open to everyone when the wiki's own
// settings say read_public. A rejected token is dropped: reads go on anonymously.
func (s *Server) open(w http.ResponseWriter, r *http.Request, name string, write bool) (*call, bool) {
	u := s.auth.CurrentUser(r)
	member := false
	if u != nil {
		a, err := s.auth.Access(r.Context(), u, name)
		switch {
		case errors.Is(err, auth.ErrUnauthorized):
			auth.ClearSession(w)
			u = nil
		case err != nil:
			http.Error(w, "permission check failed: "+err.Error(), http.StatusBadGateway)
			return nil, false
		case write && !a.Write:
			http.Error(w, "forbidden", http.StatusForbidden)
			return nil, false
		default:
			member = a.Read
		}
	}
	denied := func() (*call, bool) {
		if u != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
		} else {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}
		return nil, false
	}
	if write && u == nil {
		return denied()
	}
	// Outsiders learn nothing about which repos have the App, or why one cannot be opened.
	rr, err := s.git.Get(r.Context(), name)
	if err != nil {
		if !member {
			return denied()
		}
		fail(w, err)
		return nil, false
	}
	if err := rr.EnsureCloned(r.Context()); err != nil {
		if !member {
			return denied()
		}
		http.Error(w, "clone failed: "+err.Error(), http.StatusInternalServerError)
		return nil, false
	}
	if !member && !rr.Settings().ReadPublic {
		return denied()
	}
	return &call{slug: rr.Slug(), repo: rr, user: u}, true
}

// fail answers err with the status code that tells the client what went wrong.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gitstore.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, gitstore.ErrExists):
		http.Error(w, "目标位置已有同名页面或评论记录", http.StatusConflict)
	case errors.Is(err, gitstore.ErrConflict):
		http.Error(w, err.Error(), http.StatusConflict)
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
	c, ok := s.open(w, r, r.URL.Query().Get("repo"), false)
	if !ok {
		return
	}
	if c.user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
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
	switch r.URL.Query().Get("mode") {
	case "md":
		// The raw file as stored in the repo; title goes on top so the downloaded file reads
		// as a document on its own.
		out := f.Body
		if f.Title != "" {
			out = "# " + f.Title + "\n\n" + out
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `inline`)
		_, _ = w.Write([]byte(out))
		return
	case "print":
		// Print-friendly HTML: minimum styling, print dialog opens by itself.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(printPage(f.Title, f.Body)))
		return
	}
	resp := map[string]any{
		"id":              id,
		"title":           f.Title,
		"body":            f.Body,
		"meta":            gitstore.MetaOf(f.RawMeta),
		"base_sha":        f.BaseSHA,
		"is_bundle":       isBundle,
		"last_author":     f.LastAuthor,
		"last_commit_sha": f.LastCommitSHA,
		"last_commit_at":  f.LastCommitAt,
	}
	if c.user == nil {
		// Anonymous readers share caches (e.g. corporate proxies): base_sha could be reused
		// to overtake an editor's merge, so it is only sent to people who may save.
		delete(resp, "base_sha")
	}
	writeJSON(w, resp)
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
	if c.user == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
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
	Template string `json:"template"`
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
	id, err := c.repo.CreatePage(r.Context(), req.ParentID, req.Title, req.Template, c.user)
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
	newID, links, err := s.comments.MovePage(r.Context(), c.repo, req.ID, req.ParentID, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastMoved(c.slug, c.user.Login, req.ID, newID)
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

// retag renames a tag on every page (to "": removes it), or with pages adds or removes one
// on just those pages.
func (s *Server) retag(w http.ResponseWriter, r *http.Request, c *call) {
	var req struct {
		From  string   `json:"from"`
		To    string   `json:"to"`
		Pages []string `json:"pages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	pages, err := c.repo.Retag(r.Context(), strings.TrimSpace(req.From), strings.TrimSpace(req.To), req.Pages, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	if len(pages) > 0 {
		s.present.BroadcastChanged(c.slug, c.user.Login, pages...)
	}
	writeJSON(w, map[string]any{"pages": pages})
}

func (s *Server) searchPages(w http.ResponseWriter, r *http.Request, c *call) {
	query := r.URL.Query()
	opts := gitstore.SearchOptions{Directory: query.Get("directory"), Tag: query.Get("tag")}
	if draft := query.Get("draft"); draft != "" {
		if draft != "true" && draft != "false" {
			http.Error(w, "draft must be true or false", http.StatusBadRequest)
			return
		}
		value := draft == "true"
		opts.Draft = &value
	}
	if after := query.Get("updated_after"); after != "" {
		var err error
		opts.UpdatedAfter, err = time.Parse(time.RFC3339, after)
		if err != nil {
			http.Error(w, "updated_after must be RFC3339", http.StatusBadRequest)
			return
		}
	}
	hits, err := c.repo.Search(r.Context(), query.Get("q"), opts)
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

// printPage renders the markdown body into a minimal printable page. We don't try to be
// fancy: GitHub-flavored markdown is close enough for handing to an outside reader, and
// the browser's "另存为 PDF" produces the actual PDF.
func printPage(title, body string) string {
	titleEsc := template.HTMLEscapeString(title)
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>` + titleEsc + `</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1c1917; line-height: 1.8; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.4em; margin-top: 1.6em; } h3 { font-size: 1.15em; margin-top: 1.4em; }
  pre { background: #f5f5f4; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.9em; }
  code { background: #f5f5f4; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #e7e5e4; padding: 6px 10px; text-align: left; }
  blockquote { border-left: 3px solid #d6d3d1; margin-left: 0; padding-left: 14px; color: #57534e; }
  img { max-width: 100%; }
</style>
</head>
<body>
<h1>` + titleEsc + `</h1>
` + mdToHTML(body) + `
<script>window.onload = () => setTimeout(() => window.print(), 200)</script>
</body>
</html>`
}

// mdToHTML is the bare minimum for printing: paragraphs, headings, lists, code, blockquote,
// tables. Anything else renders as preformatted text, which is still readable.
func mdToHTML(src string) string {
	var out strings.Builder
	lines := strings.Split(src, "\n")
	inPre, inList, inTable := false, false, false
	closeBlocks := func() {
		if inList {
			out.WriteString("</ul>")
			inList = false
		}
		if inTable {
			out.WriteString("</table>")
			inTable = false
		}
	}
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "```"):
			closeBlocks()
			if inPre {
				out.WriteString("</code></pre>")
				inPre = false
			} else {
				out.WriteString("<pre><code>")
				inPre = true
			}
		case inPre:
			out.WriteString(template.HTMLEscapeString(line) + "\n")
		case strings.HasPrefix(trim, "# "):
			closeBlocks()
			out.WriteString("<h1>" + mdInline(trim[2:]) + "</h1>")
		case strings.HasPrefix(trim, "## "):
			closeBlocks()
			out.WriteString("<h2>" + mdInline(trim[3:]) + "</h2>")
		case strings.HasPrefix(trim, "### "):
			closeBlocks()
			out.WriteString("<h3>" + mdInline(trim[4:]) + "</h3>")
		case strings.HasPrefix(trim, "|") && strings.HasSuffix(trim, "|"):
			if !inTable {
				closeBlocks()
				out.WriteString("<table>")
				inTable = true
			}
			cells := strings.Split(strings.Trim(trim, "|"), "|")
			var row strings.Builder
			row.WriteString("<tr>")
			for _, c := range cells {
				row.WriteString("<td>" + mdInline(strings.TrimSpace(c)) + "</td>")
			}
			row.WriteString("</tr>")
			out.WriteString(row.String())
		case strings.HasPrefix(trim, "- ") || strings.HasPrefix(trim, "* "):
			if !inList {
				closeBlocks()
				out.WriteString("<ul>")
				inList = true
			}
			out.WriteString("<li>" + mdInline(trim[2:]) + "</li>")
		case strings.HasPrefix(trim, "> "):
			closeBlocks()
			out.WriteString("<blockquote>" + mdInline(trim[2:]) + "</blockquote>")
		case trim == "":
			closeBlocks()
		default:
			closeBlocks()
			out.WriteString("<p>" + mdInline(trim) + "</p>")
		}
	}
	closeBlocks()
	if inPre {
		out.WriteString("</code></pre>")
	}
	return out.String()
}

var (
	mdBold   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	mdItalic = regexp.MustCompile(`\*([^*\n]+)\*`)
	mdCode   = regexp.MustCompile("`([^`]+)`")
	mdLink   = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	mdImage  = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
)

func mdInline(s string) string {
	s = template.HTMLEscapeString(s)
	s = mdImage.ReplaceAllString(s, `<img src="$2" alt="$1">`)
	s = mdLink.ReplaceAllString(s, `<a href="$2">$1</a>`)
	s = mdCode.ReplaceAllString(s, `<code>$1</code>`)
	s = mdBold.ReplaceAllString(s, `<strong>$1</strong>`)
	s = mdItalic.ReplaceAllString(s, `<em>$1</em>`)
	return s
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// listComments returns the saved and pending comments of one page.
func (s *Server) listComments(w http.ResponseWriter, r *http.Request, c *call) {
	pageID := r.URL.Query().Get("page_id")
	if pageID == "" {
		http.Error(w, "page_id required", http.StatusBadRequest)
		return
	}
	comments, err := s.comments.List(c.repo, pageID)
	if err != nil {
		fail(w, err)
		return
	}
	byUser := make(map[string]string, len(comments))
	for _, cm := range comments {
		byUser[cm.ID] = cm.By
	}
	s.present.BroadcastComments(c.slug, pageID, byUser)
	writeJSON(w, comments)
}

type commentReq struct {
	PageID      string               `json:"page_id"`
	Text        string               `json:"text"`
	Anchor      *comments.TextAnchor `json:"anchor"`
	Save        bool                 `json:"save"` // commit into the repo vs. only keep in memory
	ContextBody string               `json:"-"`    // "": use current body; else the anchor was made against this
	BaseSHA     string               `json:"-"`    // shadowed below
}

func (s *Server) postComment(w http.ResponseWriter, r *http.Request, c *call) {
	var req struct {
		PageID string `json:"page_id"`
		Text   string `json:"text"`
		Anchor *struct {
			Quote    string `json:"quote"`
			Prefix   string `json:"prefix"`
			Suffix   string `json:"suffix"`
			StartRaw int    `json:"start_raw"`
			EndRaw   int    `json:"end_raw"`
		} `json:"anchor"`
		Save bool `json:"save"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.PageID == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "page_id and text required", http.StatusBadRequest)
		return
	}
	var anchor *comments.TextAnchor
	if req.Anchor != nil {
		anchor = &comments.TextAnchor{
			Quote:    req.Anchor.Quote,
			Prefix:   req.Anchor.Prefix,
			Suffix:   req.Anchor.Suffix,
			StartRaw: req.Anchor.StartRaw,
			EndRaw:   req.Anchor.EndRaw,
		}
	}
	cm, err := s.comments.Add(c.repo, req.PageID, req.Text, req.Save, anchor, c.user)
	if err != nil {
		fail(w, err)
		return
	}
	if !req.Save {
		s.present.BroadcastComments(c.slug, req.PageID, map[string]string{cm.ID: c.user.Login})
	}
	writeJSON(w, cm)
}

// copyPage duplicates id (without children) under parentID with a "-副本" title.
func (s *Server) copyPage(w http.ResponseWriter, r *http.Request, c *call) {
	var req struct {
		ID       string `json:"id"`
		ParentID string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	f, isBundle, err := c.repo.ReadPage(r.Context(), req.ID)
	if err != nil {
		fail(w, err)
		return
	}
	doc := &gitstore.PageDoc{FrontMatter: maps.Clone(f.RawMeta), Body: f.Body}
	doc.FrontMatter["title"] = f.Title + "-副本"
	id, err := c.repo.CreatePage(r.Context(), req.ParentID, doc.FrontMatter["title"].(string), "", c.user)
	if err != nil {
		fail(w, err)
		return
	}
	if _, err := c.repo.SavePage(r.Context(), id, doc, "", "wiki: copy "+req.ID, c.user); err != nil {
		fail(w, err)
		return
	}
	if isBundle {
		assets, _ := c.repo.ListAssets(r.Context(), req.ID)
		for _, name := range assets {
			file, err := c.repo.ReadAssetFile(r.Context(), req.ID, name)
			if err != nil {
				continue
			}
			_, _ = c.repo.SaveAsset(r.Context(), id, name, file, c.user)
			file.Close()
		}
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, id)
	writeJSON(w, map[string]string{"id": id})
}

// trash lists the pages whose last change deleted them — the same data as 最近更新, but
// without its "30 条" cap, and only deletions.
func (s *Server) trash(w http.ResponseWriter, r *http.Request, c *call) {
	changes, err := c.repo.RecentChanges(r.Context(), 500)
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]gitstore.Change, 0)
	for _, ch := range changes {
		if ch.Deleted {
			out = append(out, ch)
		}
	}
	writeJSON(w, out)
}

// importPage converts pasted markup of a type the wiki's settings accept into markdown and creates
// the page. "mediawiki" references docs/mediawiki.md so convert live against the real files.
func (s *Server) importPage(w http.ResponseWriter, r *http.Request, c *call) {
	source := c.repo.Settings().Source
	if len(source) == 0 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "multipart: "+err.Error(), http.StatusBadRequest)
		return
	}
	type_ := r.FormValue("type")
	if !slices.Contains(source, type_) {
		http.Error(w, "this repo does not accept "+type_, http.StatusForbidden)
		return
	}
	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		http.Error(w, "title required", http.StatusBadRequest)
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "file field required", http.StatusBadRequest)
		return
	}
	defer file.Close()
	doc, err := importer.Convert(type_, hdr.Filename, file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	doc.FrontMatter["title"] = title
	id, err := c.repo.CreatePage(r.Context(), r.FormValue("parent_id"), title, "", c.user)
	if err != nil {
		fail(w, err)
		return
	}
	if _, err := c.repo.SavePage(r.Context(), id, doc, "", "wiki: import "+title, c.user); err != nil {
		fail(w, err)
		return
	}
	s.present.BroadcastChanged(c.slug, c.user.Login, id)
	writeJSON(w, map[string]string{"id": id})
}
