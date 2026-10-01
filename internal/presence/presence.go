// Package presence tracks "who is editing what page" via websockets.
package presence

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/jimyag/gitwiki/internal/auth"
)

type Peer struct {
	User    string `json:"user"`
	Name    string `json:"name"`
	Page    string `json:"page"`
	Since   int64  `json:"since"`
	Editing bool   `json:"editing,omitempty"` // the editor is open on this page
}

type client struct {
	user    *auth.User
	page    string
	repo    string
	editing bool
	since   int64
	conn    *websocket.Conn
	send    chan outbound
}

type inbound struct {
	Type   string `json:"type"` // "cursor", "editing"
	Anchor int    `json:"anchor"`
	Head   int    `json:"head"`
	Edit   bool   `json:"edit"`
}

type outbound struct {
	Type  string   `json:"type"`
	Edit  bool     `json:"edit,omitempty"` // "editing": whether the sender's editor is open
	Peers []Peer   `json:"peers,omitempty"`
	User  string   `json:"user,omitempty"`
	Page  string   `json:"page,omitempty"`
	Pages []string `json:"pages,omitempty"` // "changed": the pages that changed

	// cursor broadcast
	Anchor int    `json:"anchor,omitempty"` // absolute offset in doc
	Head   int    `json:"head,omitempty"`   // selection head (== anchor if no selection)
	Color  string `json:"color,omitempty"`  // server-assigned stable color for the user

	Error string `json:"error,omitempty"` // "sync": why pushing to origin failed; empty once it works
}

type Hub struct {
	mu     sync.Mutex
	rooms  map[string]map[*client]bool
	auth   *auth.Store
	colors map[string]string // user login → color (stable per session)
}

func NewHub(as *auth.Store) *Hub {
	return &Hub{rooms: map[string]map[*client]bool{}, auth: as, colors: map[string]string{}}
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
	cl := &client{user: u, repo: repo, page: page, conn: c, send: make(chan outbound, 16), since: time.Now().Unix()}
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

var palette = []string{
	"#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#14b8a6", "#f97316",
}

// colorFor returns a stable color per user login (same client-side algorithm
// as Sidebar.colorForUser). Does not need Hub state; kept as method for API shape.
func (h *Hub) colorFor(user string) string {
	var hash uint32
	for i := 0; i < len(user); i++ {
		hash = (hash*31 + uint32(user[i])) & 0xffffffff
	}
	return palette[int(hash)%len(palette)]
}

func snapshotLocked(room map[*client]bool) []Peer {
	out := make([]Peer, 0, len(room))
	for c := range room {
		out = append(out, Peer{User: c.user.Login, Name: displayName(c.user), Page: c.page, Since: c.since, Editing: c.editing})
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

// BroadcastChanged tells everyone in repo that pages changed (saved, created, moved, deleted;
// none for a reorder), so they refresh the page tree and see whether the page they have open
// is stale. byUser is "" for commits pulled from GitHub.
func (h *Hub) BroadcastChanged(repo, byUser string, pages ...string) {
	h.broadcastRepo(repo, outbound{Type: "changed", User: byUser, Pages: pages})
}

// BroadcastSync tells everyone on any page of repo whether the last push to origin worked.
func (h *Hub) BroadcastSync(repo string, err error) {
	msg := outbound{Type: "sync"}
	if err != nil {
		msg.Error = err.Error()
	}
	h.broadcastRepo(repo, msg)
}

// BroadcastComments tells everyone on repo/page which comment ids belong to byUser.
// Editors use it to refresh the sidebar; other readers ignore "comments" messages.
func (h *Hub) BroadcastComments(repo, page string, byUser map[string]string) {
	logins := make([]string, 0, len(byUser))
	for _, l := range byUser {
		logins = append(logins, l)
	}
	h.broadcastRepo(repo, outbound{Type: "comments", User: strings.Join(logins, ","), Page: page})
}

func (h *Hub) broadcastRepo(repo string, msg outbound) {
	h.mu.Lock()
	defer h.mu.Unlock() // broadcast never blocks, and the rooms must not change under it
	for key, room := range h.rooms {
		if strings.HasPrefix(key, repo+"/") {
			h.broadcast(room, msg, nil)
		}
	}
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
		// Tell others to clear my cursor
		h.broadcast(room, outbound{Type: "cursor-left", User: c.user.Login}, nil)
	}()
	for {
		var msg inbound
		if err := wsjson.Read(ctx, c.conn, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "cursor":
			h.mu.Lock()
			color := h.colorFor(c.user.Login)
			h.mu.Unlock()
			h.broadcast(room, outbound{
				Type: "cursor", User: c.user.Login,
				Anchor: msg.Anchor, Head: msg.Head, Color: color,
			}, c) // don't echo to self
		case "editing":
			h.mu.Lock()
			c.editing = msg.Edit
			h.mu.Unlock()
			h.broadcast(room, outbound{Type: "editing", User: c.user.Login, Edit: msg.Edit}, nil)
		}
	}
}
