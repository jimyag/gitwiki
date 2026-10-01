import { useStore, type RemoteCursor } from "../store";

let ws: WebSocket | null = null;
let currentKey: string | null = null;

export function connectPresence(slug: string, pageId: string) {
  const key = `${slug}/${pageId}`;
  if (currentKey === key && ws && ws.readyState <= 1) return;
  disconnectPresence();
  currentKey = key;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}/ws?repo=${encodeURIComponent(slug)}&page=${encodeURIComponent(pageId)}`);
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const st = useStore.getState();
      if (msg.type === "peers") {
        st.setPeers(msg.peers || []);
      } else if (msg.type === "changed") {
        // Someone (or a commit pulled from GitHub: no user) changed pages: the tree may differ,
        // and the open page may now be stale.
        void st.refreshTree();
        const pages: string[] = msg.pages ?? [];
        if (msg.user !== st.user?.login && st.currentPageId && pages.includes(st.currentPageId)) {
          st.onSaved(msg.user ?? "");
        }
      } else if (msg.type === "cursor") {
        st.setRemoteCursor(msg.user, {
          user: msg.user,
          anchor: msg.anchor,
          head: msg.head,
          color: msg.color,
          at: Date.now(),
        } as RemoteCursor);
      } else if (msg.type === "cursor-left") {
        st.removeRemoteCursor(msg.user);
      } else if (msg.type === "sync") {
        st.setSyncError(msg.error || null);
      }
    } catch {}
  };
  ws.onclose = () => {
    if (currentKey === key) {
      setTimeout(() => {
        if (currentKey === key && useStore.getState().currentPageId) {
          connectPresence(slug, pageId);
        }
      }, 2000);
    }
  };
}

export function disconnectPresence() {
  currentKey = null;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

export function sendCursor(anchor: number, head: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "cursor", anchor, head }));
}
