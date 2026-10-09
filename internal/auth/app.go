package auth

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

// ErrNotInstalled: the GitHub App is not installed on the repo, so it is no wiki.
var ErrNotInstalled = errors.New("GitHub App 没有安装到这个仓库")

// RepoInfo is what GitHub says about a repo the App is installed on.
type RepoInfo struct {
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	DefaultBranch string `json:"default_branch"`
	Homepage      string `json:"homepage"`
	WikiBranch    bool   `json:"-"` // it has a branch named "wiki"
}

// App is gitwiki's GitHub App acting as itself. Its installation tokens let the server clone,
// pull and push a wiki repo whoever is logged in, or nobody: GitHub issues them for an hour,
// against a JWT signed with the App's private key.
type App struct {
	clientID string
	key      *rsa.PrivateKey

	mu     sync.Mutex
	tokens map[string]appToken // by GitHub repo "owner/name"
}

type appToken struct {
	value   string
	expires time.Time
}

// NewApp loads the App's private key, as GitHub hands it out (PKCS#1 PEM; PKCS#8 works too).
func NewApp(clientID, keyFile string) (*App, error) {
	data, err := os.ReadFile(keyFile) // #nosec G304 -- the operator's configured key file.
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("%s: no PEM block", keyFile)
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		parsed, err8 := x509.ParsePKCS8PrivateKey(block.Bytes)
		rsaKey, ok := parsed.(*rsa.PrivateKey)
		if err8 != nil || !ok {
			return nil, fmt.Errorf("%s: not an RSA private key: %w", keyFile, err)
		}
		key = rsaKey
	}
	return &App{clientID: clientID, key: key, tokens: map[string]appToken{}}, nil
}

// Repo asks GitHub, as the App, about repo "owner/name": its canonical name, default branch
// and website, and whether it has a "wiki" branch.
func (a *App) Repo(ctx context.Context, repo string) (RepoInfo, error) {
	token, err := a.Token(ctx, repo)
	if err != nil {
		return RepoInfo{}, err
	}
	var info RepoInfo
	switch status, err := appCall(ctx, "GET", githubAPI+"/repos/"+repo, token, nil, &info); {
	case err != nil:
		return RepoInfo{}, err
	case status == http.StatusNotFound:
		return RepoInfo{}, fmt.Errorf("%w: %s", ErrNotInstalled, repo)
	}
	status, err := appCall(ctx, "GET", githubAPI+"/repos/"+repo+"/branches/wiki", token, nil, &struct{}{})
	if err != nil {
		return RepoInfo{}, err
	}
	info.WikiBranch = status != http.StatusNotFound
	return info, nil
}

// Token returns an installation token for repo "owner/name" that can only reach that repo,
// reusing the last one while it has more than five minutes left.
func (a *App) Token(ctx context.Context, repo string) (string, error) {
	key := strings.ToLower(repo) // GitHub ignores case in names
	a.mu.Lock()
	defer a.mu.Unlock()
	if t, ok := a.tokens[key]; ok && time.Until(t.expires) > 5*time.Minute {
		return t.value, nil
	}
	jwt, err := a.jwt()
	if err != nil {
		return "", err
	}
	var inst struct {
		ID int64 `json:"id"`
	}
	switch status, err := appCall(ctx, "GET", githubAPI+"/repos/"+repo+"/installation", jwt, nil, &inst); {
	case err != nil:
		return "", err
	case status == http.StatusNotFound:
		return "", fmt.Errorf("%w: %s", ErrNotInstalled, repo)
	}
	var tok struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	scope := map[string]any{"repositories": []string{path.Base(repo)}}
	if _, err := appCall(ctx, "POST", fmt.Sprintf("%s/app/installations/%d/access_tokens", githubAPI, inst.ID), jwt, scope, &tok); err != nil {
		return "", err
	}
	if tok.Token == "" { // e.g. the installation went away in between
		return "", fmt.Errorf("github app: no installation token for %s", repo)
	}
	a.tokens[key] = appToken{value: tok.Token, expires: tok.ExpiresAt}
	return tok.Token, nil
}

// jwt authenticates as the App itself, for the ten minutes GitHub allows; iat sits a minute in
// the past against clock drift.
func (a *App) jwt() (string, error) {
	now := time.Now()
	claims, err := json.Marshal(map[string]any{"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(9 * time.Minute).Unix(), "iss": a.clientID})
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	unsigned := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`)) + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(nil, a.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + enc.EncodeToString(sig), nil
}

// appCall sends a request as the App (credential: its JWT or an installation token) and
// decodes a successful answer into out. A 404 is returned as a status, not an error, for the
// caller to explain.
func appCall(ctx context.Context, method, url, credential string, body, out any) (int, error) {
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			return 0, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, url, &payload)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return resp.StatusCode, nil
	case resp.StatusCode >= 300:
		return resp.StatusCode, fmt.Errorf("github app %s %s: %s", method, url, resp.Status)
	}
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
}
