package server

import "net/http"

func (s *Server) documentHealth(w http.ResponseWriter, r *http.Request, c *call) {
	snapshot, err := c.repo.HealthSnapshot(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, snapshot)
}

func (s *Server) pageTemplates(w http.ResponseWriter, r *http.Request, c *call) {
	templates, err := c.repo.Templates(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, templates)
}
