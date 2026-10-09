package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// The App signs a JWT with its key, finds the repo's installation and exchanges it for a token
// limited to that repo. The token is reused until five minutes before it expires, and a repo
// the App is not installed on is named in the error.
func TestAppToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "app.pem")
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0o600); err != nil {
		t.Fatal(err)
	}
	minted := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// As the installation: what Repo reads.
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer tok") {
			switch strings.ToLower(r.URL.Path) { // GitHub ignores case in names
			case "/repos/o/wiki":
				_, _ = fmt.Fprint(w, `{"full_name":"o/wiki","name":"wiki","default_branch":"main","homepage":"https://docs.example.com"}`)
			case "/repos/o/wiki/branches/wiki":
				_, _ = fmt.Fprint(w, `{"name":"wiki"}`)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		var claims struct {
			Iss      string `json:"iss"`
			Iat, Exp int64
		}
		sig, _ := base64.RawURLEncoding.DecodeString(parts[len(parts)-1])
		sum := sha256.Sum256([]byte(strings.Join(parts[:len(parts)-1], ".")))
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1%len(parts)])
		if len(parts) != 3 || rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], sig) != nil ||
			json.Unmarshal(payload, &claims) != nil || claims.Iss != "Iv1.test" || claims.Exp-claims.Iat > 600 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/repos/o/wiki/installation":
			_, _ = fmt.Fprint(w, `{"id":7}`)
		case r.Method == "POST" && r.URL.Path == "/app/installations/7/access_tokens":
			var body struct {
				Repositories []string `json:"repositories"`
			}
			if json.NewDecoder(r.Body).Decode(&body) != nil || !slices.Equal(body.Repositories, []string{"wiki"}) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			minted++
			_, _ = fmt.Fprintf(w, `{"token":"tok%d","expires_at":%q}`, minted, time.Now().Add(time.Hour).Format(time.RFC3339))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer gh.Close()
	oldAPI := githubAPI
	githubAPI = gh.URL
	t.Cleanup(func() { githubAPI = oldAPI })

	app, err := NewApp("Iv1.test", keyFile)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if tok, err := app.Token(t.Context(), "o/wiki"); err != nil || tok != "tok1" {
			t.Fatalf("Token = %q, %v; want the first token, reused", tok, err)
		}
	}
	app.tokens["o/wiki"] = appToken{value: "tok1", expires: time.Now().Add(4 * time.Minute)}
	if tok, err := app.Token(t.Context(), "o/wiki"); err != nil || tok != "tok2" {
		t.Errorf("Token near expiry = %q, %v; want a new one", tok, err)
	}
	if _, err := app.Token(t.Context(), "o/other"); !errors.Is(err, ErrNotInstalled) || !strings.Contains(err.Error(), "o/other") {
		t.Errorf("Token for a repo without the App = %v", err)
	}
	// GitHub ignores case: the cached token serves "O/Wiki" too.
	info, err := app.Repo(t.Context(), "O/Wiki")
	if want := (RepoInfo{FullName: "o/wiki", Name: "wiki", DefaultBranch: "main", Homepage: "https://docs.example.com", WikiBranch: true}); err != nil || info != want || minted != 2 {
		t.Errorf("Repo = %+v, %v after %d tokens; want %+v", info, err, minted, want)
	}
	if _, err := app.Repo(t.Context(), "o/other"); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("Repo without the App = %v", err)
	}
	if _, err := NewApp("Iv1.test", filepath.Join(t.TempDir(), "missing.pem")); err == nil {
		t.Error("NewApp with a missing key file succeeded")
	}
}
