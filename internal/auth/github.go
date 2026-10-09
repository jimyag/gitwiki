package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jimyag/gitwiki/internal/config"
)

type User struct {
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Token string `json:"-"` // the GitHub App's user access token: who this is and what they may do
}

type Store struct {
	cfg *config.Config

	permMu sync.Mutex
	perms  map[string]permEntry // login, GitHub repo and token digest
	lists  map[string]listEntry // login and token digest
}

// UserRepo is a wiki someone can see: a repo the App is installed on that they may read.
type UserRepo struct {
	FullName    string `json:"full_name"`
	Name        string `json:"name"`
	Permissions struct {
		Pull bool `json:"pull"`
		Push bool `json:"push"`
	} `json:"permissions"`
}

type listEntry struct {
	repos []UserRepo
	at    time.Time
}

// Access is what a user may do with a repo: Read (GitHub "pull") lets them browse the wiki,
// Write (GitHub "push") lets them change it.
type Access struct{ Read, Write bool }

type permEntry struct {
	access Access
	at     time.Time
}

// permTTL is how long a permission answer is reused: every repo request checks it, and a
// revoked collaborator keeps access for at most this long.
const permTTL = 5 * time.Minute

var ErrUnauthorized = errors.New("github login expired; sign in again")

// githubAPI is a variable so tests can point it at a fake.
var githubAPI = "https://api.github.com"

func NewStore(cfg *config.Config) *Store {
	return &Store{cfg: cfg, perms: map[string]permEntry{}, lists: map[string]listEntry{}}
}

// Repos lists the repos the App is installed on that u can see, with u's permissions on each:
// the wikis to offer them. A user token only reaches installations of this App. Answers are
// cached like Access.
func (s *Store) Repos(ctx context.Context, u *User) ([]UserRepo, error) {
	if u.Token == "" {
		return nil, ErrUnauthorized
	}
	key := fmt.Sprintf("%s\x00%x", u.Login, sha256.Sum256([]byte(u.Token)))
	s.permMu.Lock()
	e, ok := s.lists[key]
	s.permMu.Unlock()
	if ok && time.Since(e.at) < permTTL {
		return e.repos, nil
	}
	var installs struct {
		Installations []struct {
			ID int64 `json:"id"`
		} `json:"installations"`
	}
	if err := userGet(ctx, u.Token, "/user/installations?per_page=100", &installs); err != nil {
		return nil, err
	}
	repos := []UserRepo{}
	for _, in := range installs.Installations {
		for page := 1; ; page++ {
			var body struct {
				Repositories []UserRepo `json:"repositories"`
			}
			if err := userGet(ctx, u.Token, fmt.Sprintf("/user/installations/%d/repositories?per_page=100&page=%d", in.ID, page), &body); err != nil {
				return nil, err
			}
			repos = append(repos, body.Repositories...)
			if len(body.Repositories) < 100 {
				break
			}
		}
	}
	s.permMu.Lock()
	s.lists[key] = listEntry{repos: repos, at: time.Now()}
	s.permMu.Unlock()
	return repos, nil
}

// userGet reads a GitHub API path as the user; a rejected token is ErrUnauthorized.
func userGet(ctx context.Context, token, path string, out any) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", githubAPI+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return ErrUnauthorized
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("github %s: %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// BeginAuth redirects to GitHub authorize page. state is returned via the cookie-less
// round trip; we keep it in a short-lived server-side map implicitly by using a random
// state value stored in the session cookie. For skeleton simplicity state is embedded
// in the callback verification only.
func (s *Store) BeginAuth(w http.ResponseWriter, r *http.Request) {
	state := randState()
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		MaxAge:   300,
	})
	// Where to land after login (the page a logged-out reader opened).
	if next := r.URL.Query().Get("next"); localPath(next) {
		http.SetCookie(w, &http.Cookie{Name: "oauth_next", Value: url.QueryEscape(next), Path: "/", HttpOnly: true, MaxAge: 300})
	}
	// A GitHub App's permissions come from its registration, not from scopes.
	q := url.Values{
		"client_id": {s.cfg.Github.ClientID},
		"state":     {state},
	}
	http.Redirect(w, r, "https://github.com/login/oauth/authorize?"+q.Encode(), http.StatusFound)
}

func (s *Store) HandleCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie("oauth_state")
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		http.Error(w, "bad oauth state", http.StatusBadRequest)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	token, err := s.exchangeCode(r.Context(), code)
	if err != nil {
		http.Error(w, "oauth exchange failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	u, err := s.fetchUser(r.Context(), token)
	if err != nil {
		http.Error(w, "fetch user failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	u.Token = token
	setSession(w, s.cfg.SessionSecret, u)
	dest := "/"
	if c, err := r.Cookie("oauth_next"); err == nil {
		if next, err := url.QueryUnescape(c.Value); err == nil && localPath(next) {
			dest = next
		}
		http.SetCookie(w, &http.Cookie{Name: "oauth_next", Path: "/", MaxAge: -1})
	}
	http.Redirect(w, r, dest, http.StatusFound)
}

// localPath accepts only same-site paths, so the post-login redirect cannot be bounced
// to another host ("//evil", "/\evil", "https://…").
func localPath(p string) bool {
	return strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") && !strings.ContainsAny(p, "\\\r\n")
}

func (s *Store) CurrentUser(r *http.Request) *User {
	return readSession(r, s.cfg.SessionSecret)
}

// Access reports what the user's token may do with repo "owner/name".
// Answers are cached per user and repo for permTTL; errors are not cached.
func (s *Store) Access(ctx context.Context, u *User, githubRepo string) (Access, error) {
	if u.Token == "" {
		return Access{}, ErrUnauthorized
	}
	// A new login must not reuse an older token's permissions. Keep raw tokens out of cache keys.
	key := fmt.Sprintf("%s\x00%s\x00%x", u.Login, githubRepo, sha256.Sum256([]byte(u.Token)))
	s.permMu.Lock()
	e, ok := s.perms[key]
	s.permMu.Unlock()
	if ok && time.Since(e.at) < permTTL {
		return e.access, nil
	}
	a, err := fetchAccess(ctx, u.Token, githubRepo)
	if err != nil {
		return Access{}, err
	}
	s.permMu.Lock()
	s.perms[key] = permEntry{access: a, at: time.Now()}
	s.permMu.Unlock()
	return a, nil
}

func fetchAccess(ctx context.Context, token, githubRepo string) (Access, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", githubAPI+"/repos/"+githubRepo, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return Access{}, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return Access{}, ErrUnauthorized
	case http.StatusNotFound: // repo invisible to this token
		return Access{}, nil
	default: // e.g. rate limited: an error, so a GitHub hiccup is not cached as "no access"
		return Access{}, fmt.Errorf("github repo %s: %s", githubRepo, resp.Status)
	}
	var body struct {
		Permissions struct {
			Pull bool `json:"pull"`
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Access{}, err
	}
	return Access{Read: body.Permissions.Pull || body.Permissions.Push, Write: body.Permissions.Push}, nil
}

func (s *Store) exchangeCode(ctx context.Context, code string) (string, error) {
	form := url.Values{
		"client_id":     {s.cfg.Github.ClientID},
		"client_secret": {s.cfg.Github.ClientSecret},
		"code":          {code},
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://github.com/login/oauth/access_token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.Error != "" {
		return "", fmt.Errorf("github oauth error: %s", body.Error)
	}
	return body.AccessToken, nil
}

func (s *Store) fetchUser(ctx context.Context, token string) (*User, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/user", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var u User
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return nil, err
	}
	if u.Email == "" {
		u.Email = u.Login + "@users.noreply.github.com"
	}
	return &u, nil
}

func randState() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
