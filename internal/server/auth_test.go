package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jimyag/gitwiki/internal/auth"
	"github.com/jimyag/gitwiki/internal/config"
	"github.com/jimyag/gitwiki/internal/gitstore"
)

type githubTransport func(*http.Request) (*http.Response, error)

func (f githubTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Obtain the cookie through the real OAuth callback, then simulate a revoked token.
func expiredSession(t *testing.T) (*auth.Store, *http.Cookie) {
	return githubSession(t, http.StatusUnauthorized, `{"message":"Bad credentials"}`)
}

// githubSession logs user u in; GitHub then answers what the token may do with repo o/repo
// (and the list of wikis) with repoStatus and repoBody.
func githubSession(t *testing.T, repoStatus int, repoBody string) (*auth.Store, *http.Cookie) {
	t.Helper()
	oldClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: githubTransport(func(r *http.Request) (*http.Response, error) {
		status, body := http.StatusOK, ""
		switch r.URL.Host + r.URL.Path {
		case "github.com/login/oauth/access_token":
			body = `{"access_token":"revoked"}`
		case "api.github.com/user":
			body = `{"login":"u"}`
		case "api.github.com/repos/o/repo", "api.github.com/user/installations":
			status, body = repoStatus, repoBody
		default:
			t.Errorf("unexpected GitHub request: %s", r.URL.Host+r.URL.Path)
			status = http.StatusInternalServerError
		}
		return &http.Response{StatusCode: status, Status: http.StatusText(status), Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = oldClient })
	as := auth.NewStore(&config.Config{SessionSecret: "test"})
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

// wiki is a manager holding wiki o/repo, already cloned, with read_public as its own
// .gitwiki/config.yaml says. Other repos have no App installed.
func wiki(t *testing.T, readPublic bool) *gitstore.Manager {
	t.Helper()
	data := t.TempDir()
	dir := filepath.Join(data, "o", "repo")
	files := map[string]string{"content/_index.md": "home\n"}
	if readPublic {
		files[".gitwiki/config.yaml"] = "read_public: true\n"
	}
	for rel, body := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"add", "."}, {"-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", "init"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	return gitstore.NewManager(data, nil, func(_ context.Context, name string) (auth.RepoInfo, error) {
		if name != "o/repo" {
			return auth.RepoInfo{}, auth.ErrNotInstalled
		}
		return auth.RepoInfo{FullName: "o/repo", Name: "repo", DefaultBranch: "main"}, nil
	})
}

func TestSyncRequiresWriteAccess(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			as, cookie := githubSession(t, http.StatusOK, `{"permissions":{"pull":true,"push":false}}`)
			s := New(as, wiki(t, true), nil, nil)
			for _, signedIn := range []bool{false, true} {
				r := httptest.NewRequest(method, "/api/repos/o/repo/sync", nil)
				want := http.StatusUnauthorized
				if signedIn {
					r.AddCookie(cookie)
					want = http.StatusForbidden
				}
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				if w.Code != want {
					t.Fatalf("signed in %v: got %d, want %d", signedIn, w.Code, want)
				}
			}
		})
	}
}

func TestExpiredSession(t *testing.T) {
	for _, path := range []string{"/api/me", "/api/repos/o/repo/pages", "/api/repos/o/repo/health", "/api/repos/o/repo/templates", "/o/repo.md", "/ws?repo=o/repo"} {
		t.Run(path, func(t *testing.T) {
			as, cookie := expiredSession(t)
			s := New(as, wiki(t, false), nil, nil)
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.AddCookie(cookie)
			w := httptest.NewRecorder()
			if path == "/o/repo.md" {
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

// A wiki whose own settings say read_public stays readable when a token expires, but the
// expired token cannot write; anonymous visitors cannot tell an App-less repo from a private wiki.
func TestPublicReadFollowsRepoSettings(t *testing.T) {
	as, cookie := expiredSession(t)
	s := New(as, wiki(t, true), nil, nil)
	for _, c := range []struct {
		method, path string
		anonymous    bool
		want         int
	}{
		{http.MethodGet, "/api/repos/o/repo/pages", false, http.StatusOK},
		{http.MethodGet, "/api/repos/o/repo/settings", false, http.StatusOK},
		{http.MethodPut, "/api/repos/o/repo/page", false, http.StatusUnauthorized},
		{http.MethodGet, "/api/repos/o/repo/pages", true, http.StatusOK},
		{http.MethodGet, "/api/repos/o/other/pages", true, http.StatusUnauthorized},
	} {
		r := httptest.NewRequest(c.method, c.path, nil)
		if !c.anonymous {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s %s: got %d, want %d: %s", c.method, c.path, w.Code, c.want, w.Body.String())
		}
	}
}
