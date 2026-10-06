package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
)

type githubTransport func(*http.Request) (*http.Response, error)

func (f githubTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Obtain the cookie through the real OAuth callback, then simulate a revoked token.
func expiredSession(t *testing.T, cfg *config.Config) (*auth.Store, *http.Cookie) {
	t.Helper()
	oldClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: githubTransport(func(r *http.Request) (*http.Response, error) {
		status, body := http.StatusOK, ""
		switch r.URL.Host + r.URL.Path {
		case "github.com/login/oauth/access_token":
			body = `{"access_token":"revoked"}`
		case "api.github.com/user":
			body = `{"login":"u"}`
		case "api.github.com/repos/o/repo":
			status, body = http.StatusUnauthorized, `{"message":"Bad credentials"}`
		default:
			t.Errorf("unexpected GitHub request: %s", r.URL.Host+r.URL.Path)
			status = http.StatusInternalServerError
		}
		return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = oldClient })
	as := auth.NewStore(cfg)
	r := httptest.NewRequest(http.MethodGet, "/auth/callback?code=test&state=test", nil)
	r.AddCookie(&http.Cookie{Name: "oauth_state", Value: "test"})
	w := httptest.NewRecorder()
	as.HandleCallback(w, r)
	if w.Code != http.StatusFound {
		t.Fatalf("callback: %d %s", w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "gitwiki_session" {
			return as, c
		}
	}
	t.Fatal("callback did not set a session cookie")
	return nil, nil
}

func TestExpiredSession(t *testing.T) {
	for _, path := range []string{"/api/me", "/api/repos/wiki/pages", "/wiki.md", "/ws?repo=wiki"} {
		t.Run(path, func(t *testing.T) {
			cfg := &config.Config{SessionSecret: "test", Repos: []config.Repo{{Slug: "wiki", Github: "o/repo"}}}
			as, cookie := expiredSession(t, cfg)
			s := New(cfg, as, nil, nil, nil)
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.AddCookie(cookie)
			w := httptest.NewRecorder()
			if path == "/wiki.md" {
				// Reach the source-download authorization without requiring embedded assets.
				s.static = fstest.MapFS{}
			}
			s.Handler().ServeHTTP(w, r)
			if path == "/api/me" {
				var me struct{ User *auth.User }
				if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil || w.Code != http.StatusOK || me.User != nil {
					t.Fatalf("expired session must return user:null: %d %s (%v)", w.Code, w.Body.String(), err)
				}
			} else if w.Code != http.StatusUnauthorized {
				t.Fatalf("got %d, want 401: %s", w.Code, w.Body.String())
			}
			cleared := false
			for _, c := range w.Result().Cookies() {
				cleared = cleared || c.Name == "gitwiki_session" && c.MaxAge < 0
			}
			if !cleared {
				t.Fatal("expired session cookie was not cleared")
			}
		})
	}
}

func TestExpiredSessionPublicRead(t *testing.T) {
	cfg := &config.Config{SessionSecret: "test", Repos: []config.Repo{{Slug: "wiki", Github: "o/repo", ReadPublic: true}}}
	as, cookie := expiredSession(t, cfg)
	s := New(cfg, as, nil, nil, nil)
	r := httptest.NewRequest(http.MethodGet, "/api/repos/wiki/pages", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	if u, ok := s.authorize(w, r, as.CurrentUser(r), &cfg.Repos[0], false); !ok || u != nil {
		t.Fatalf("a public wiki must remain readable after a token expires: %d", w.Code)
	}
	w = httptest.NewRecorder()
	if _, ok := s.authorize(w, r, as.CurrentUser(r), &cfg.Repos[0], true); ok || w.Code != http.StatusUnauthorized {
		t.Fatalf("an expired token must not write: %d", w.Code)
	}
}
