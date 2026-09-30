package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/jimyag/gitwiki/internal/config"
)

type User struct {
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Token string `json:"-"` // oauth access token, used for git push
}

type Store struct {
	cfg *config.Config
}

func NewStore(cfg *config.Config) *Store {
	return &Store{cfg: cfg}
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
	q := url.Values{
		"client_id": {s.cfg.Github.ClientID},
		"state":     {state},
		"scope":     {"repo user:email"},
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
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Store) CurrentUser(r *http.Request) *User {
	return readSession(r, s.cfg.SessionSecret)
}

// CanPush reports whether user's token grants push on repo "owner/name".
func (s *Store) CanPush(ctx context.Context, u *User, githubRepo string) (bool, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+githubRepo, nil)
	req.Header.Set("Authorization", "Bearer "+u.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, nil
	}
	var body struct {
		Permissions struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return false, err
	}
	return body.Permissions.Push, nil
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
