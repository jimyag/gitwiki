package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jimyag/gitwiki/internal/config"
)

// GitHub's permissions map to read/write, unknown or private repos mean no access, a GitHub
// error is not cached, and a second check within the TTL does not call GitHub again.
func TestAccess(t *testing.T) {
	calls := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.URL.Path {
		case "/repos/o/readonly":
			w.Write([]byte(`{"permissions":{"pull":true,"push":false}}`))
		case "/repos/o/member":
			w.Write([]byte(`{"permissions":{"pull":true,"push":true}}`))
		case "/repos/o/limited":
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gh.Close()
	oldAPI := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = oldAPI })

	s := NewStore(&config.Config{})
	u := &User{Login: "u", Token: "t"}
	for repo, want := range map[string]Access{
		"o/readonly": {Read: true},
		"o/member":   {Read: true, Write: true},
		"o/private":  {},
	} {
		got, err := s.Access(t.Context(), u, repo)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v; want %+v", repo, got, err, want)
		}
	}
	if _, err := s.Access(t.Context(), u, "o/limited"); err == nil {
		t.Error("o/limited: GitHub 403 must be an error, not cached as no access")
	}
	before := calls
	if _, err := s.Access(t.Context(), u, "o/member"); err != nil || calls != before {
		t.Errorf("cached answer should not call GitHub (calls %d → %d)", before, calls)
	}
}

func TestAccessInvalidTokenNotCached(t *testing.T) {
	calls := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer gh.Close()
	oldAPI := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = oldAPI })
	s := NewStore(&config.Config{})
	u := &User{Login: "u", Token: "revoked"}
	for range 2 {
		if _, err := s.Access(t.Context(), u, "o/repo"); !errors.Is(err, ErrUnauthorized) {
			t.Error("an invalid token must be a login error, not a cached permission denial")
		}
	}
	if calls != 2 {
		t.Fatalf("invalid token was cached: got %d requests, want 2", calls)
	}
	u.Token = ""
	if _, err := s.Access(t.Context(), u, "o/repo"); !errors.Is(err, ErrUnauthorized) || calls != 2 {
		t.Fatalf("empty token must require login without calling GitHub: %v, %d requests", err, calls)
	}
}

func TestAccessNewToken(t *testing.T) {
	calls := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") == "Bearer fresh" {
			_, _ = w.Write([]byte(`{"permissions":{"pull":true,"push":true}}`))
		} else {
			_, _ = w.Write([]byte(`{"permissions":{"pull":true,"push":false}}`))
		}
	}))
	defer gh.Close()
	oldAPI := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = oldAPI })
	s := NewStore(&config.Config{})
	u := &User{Login: "u", Token: "old"}
	if a, err := s.Access(t.Context(), u, "o/repo"); err != nil || !a.Read || a.Write {
		t.Fatalf("old token: got %+v, %v; want read-only", a, err)
	}
	u.Token = "fresh"
	for range 2 {
		if a, err := s.Access(t.Context(), u, "o/repo"); err != nil || !a.Write {
			t.Errorf("new token reused the old denial: got %+v, %v", a, err)
		}
	}
	if calls != 2 {
		t.Fatalf("got %d requests, want one per token", calls)
	}
}

// A user's wikis are the repos of every installation of the App they can reach, read page by
// page; the answer is cached per token, and a rejected token is a login error.
func TestRepos(t *testing.T) {
	calls := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer t" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		repo := func(name string, push bool) string {
			return fmt.Sprintf(`{"full_name":"o/%s","name":%q,"permissions":{"pull":true,"push":%v}}`, name, name, push)
		}
		switch r.URL.Path + "?" + r.URL.Query().Get("page") {
		case "/user/installations?":
			_, _ = fmt.Fprint(w, `{"installations":[{"id":1},{"id":2}]}`)
		case "/user/installations/1/repositories?1": // a full page: there is another
			page := make([]string, 100)
			for i := range page {
				page[i] = repo(fmt.Sprintf("r%d", i), false)
			}
			_, _ = fmt.Fprintf(w, `{"repositories":[%s]}`, strings.Join(page, ","))
		case "/user/installations/1/repositories?2":
			_, _ = fmt.Fprintf(w, `{"repositories":[%s]}`, repo("last", false))
		case "/user/installations/2/repositories?1":
			_, _ = fmt.Fprintf(w, `{"repositories":[%s]}`, repo("wiki", true))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gh.Close()
	oldAPI := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = oldAPI })
	s := NewStore(&config.Config{})
	for range 2 {
		repos, err := s.Repos(t.Context(), &User{Login: "u", Token: "t"})
		if err != nil || len(repos) != 102 || repos[100].FullName != "o/last" || repos[101].Name != "wiki" || !repos[101].Permissions.Push || repos[0].Permissions.Push {
			t.Fatalf("Repos = %d repos, %v", len(repos), err)
		}
	}
	if calls != 4 {
		t.Errorf("got %d requests, want 4 then the cache", calls)
	}
	if _, err := s.Repos(t.Context(), &User{Login: "u", Token: "revoked"}); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("rejected token = %v, want ErrUnauthorized", err)
	}
}

func TestLocalPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/test/abc#x": true, "/": true, "": false, "//evil.com": false, "/\\evil": false,
		"https://evil.com": false, "/a\r\nSet-Cookie:x": false,
	} {
		if localPath(p) != want {
			t.Errorf("localPath(%q) = %v", p, !want)
		}
	}
}
