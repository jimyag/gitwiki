import { useStore } from "../store";

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
      } else if (msg.type === "saved") {
        if (msg.sha) st.onSaved(msg.user, msg.sha);
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
