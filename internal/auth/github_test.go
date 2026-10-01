package auth

import (
	"net/http"
	"net/http/httptest"
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
	githubAPI = gh.URL

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
