package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Session cookie: base64url(payload).base64url(hmac(payload))
// payload = json{login,name,email,token,exp}
// No server-side state. Skeleton-grade; rotate by restarting.

const cookieName = "gitwiki_session"
const cookieTTL = 7 * 24 * time.Hour

type payload struct {
	Login string `json:"l"`
	Name  string `json:"n"`
	Email string `json:"e"`
	Token string `json:"t"`
	Exp   int64  `json:"x"`
}

func setSession(w http.ResponseWriter, secret string, u *User) {
	p := payload{Login: u.Login, Name: u.Name, Email: u.Email, Token: u.Token, Exp: time.Now().Add(cookieTTL).Unix()}
	raw, _ := json.Marshal(p)
	sig := sign(secret, raw)
	val := base64.RawURLEncoding.EncodeToString(raw) + "." + base64.RawURLEncoding.EncodeToString(sig)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    val,
		Path:     "/",
		HttpOnly: true,
		MaxAge:   int(cookieTTL.Seconds()),
		SameSite: http.SameSiteLaxMode,
	})
}

func readSession(r *http.Request, secret string) *User {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, sign(secret, raw)) {
		return nil
	}
	var p payload
	if json.Unmarshal(raw, &p) != nil || time.Now().Unix() > p.Exp {
		return nil
	}
	return &User{Login: p.Login, Name: p.Name, Email: p.Email, Token: p.Token}
}

func sign(secret string, raw []byte) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(raw)
	return mac.Sum(nil)
}
