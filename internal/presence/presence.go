// Package presence tracks "who is editing what page" via websockets.
package presence

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/jimyag/gitwiki/internal/auth"
)

type Peer struct {
	User  string `json:"user"`
	Name  string `json:"name"`
	Page  string `json:"page"`
	Since int64  `json:"since"`
}

type client struct {
	user *auth.User
	page string
	repo string
	conn *websocket.Conn
	send chan outbound
}

type outbound struct {
	Type  string `json:"type"`
	Peers []Peer `json:"peers,omitempty"`
	User  string `json:"user,omitempty"`
	Page  string `json:"page,omitempty"`
	SHA   string `json:"sha,omitempty"`
}

type Hub struct {
	mu    sync.Mutex
	rooms map[string]map[*client]bool
	auth  *auth.Store
}

func NewHub(as *auth.Store) *Hub {
	return &Hub{rooms: map[string]map[*client]bool{}, auth: as}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u := h.auth.CurrentUser(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	repo := r.URL.Query().Get("repo")
	page := r.URL.Query().Get("page")
	if repo == "" {
		http.Error(w, "repo required", http.StatusBadRequest)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	cl := &client{user: u, repo: repo, page: page, conn: c, send: make(chan outbound, 16)}
	key := repo + "/" + page

	h.mu.Lock()
	room := h.rooms[key]
	if room == nil {
		room = map[*client]bool{}
		h.rooms[key] = room
	}
	room[cl] = true
	peers := snapshotLocked(room)
	h.mu.Unlock()
	h.broadcast(room, outbound{Type: "peers", Peers: peers}, nil)
	if u != nil {
		h.broadcast(room, outbound{Type: "joined", User: u.Login, Page: page}, nil)
	}

	go cl.writer()
	cl.reader(room, h, key)
}

func snapshotLocked(room map[*client]bool) []Peer {
	out := make([]Peer, 0, len(room))
	for c := range room {
		out = append(out, Peer{User: c.user.Login, Name: displayName(c.user), Page: c.page, Since: time.Now().Unix()})
	}
	return out
}

func displayName(u *auth.User) string {
	if u.Name != "" {
		return u.Name
	}
	return u.Login
}

func (h *Hub) broadcast(room map[*client]bool, msg outbound, except *client) {
	for c := range room {
		if c == except {
			continue
		}
		select {
		case c.send <- msg:
		default:
		}
	}
}

func (h *Hub) BroadcastSaved(repo, page, sha, byUser string) {
	key := repo + "/" + page
	h.mu.Lock()
	room := h.rooms[key]
	h.mu.Unlock()
	if room == nil {
		return
	}
	h.broadcast(room, outbound{Type: "saved", SHA: sha, User: byUser, Page: page}, nil)
}

func (c *client) writer() {
	ctx := context.Background()
	for msg := range c.send {
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_ = wsjson.Write(wctx, c.conn, msg)
		cancel()
	}
}

func (c *client) reader(room map[*client]bool, h *Hub, key string) {
	ctx := context.Background()
	defer func() {
		h.mu.Lock()
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, key)
		}
		peers := snapshotLocked(room)
		h.mu.Unlock()
		h.broadcast(room, outbound{Type: "peers", Peers: peers}, nil)
	}()
	for {
		var v json.RawMessage
		if err := wsjson.Read(ctx, c.conn, &v); err != nil {
			return
		}
	}
}
