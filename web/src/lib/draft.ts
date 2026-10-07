import type { Meta } from "./api";

// Unsaved edits are mirrored to localStorage, so closing the tab, a crash or leaving the page
// does not lose them; the editor offers to restore a draft that differs from the saved page.
export interface Draft { title: string; body: string; meta: Meta; baseSha: string; at: number }

const key = (repo: string, id: string) => `gitwiki.draft:${repo}:${id}`;

export function moveDrafts(repo: string, from: string, to: string) {
  if (from === to) return;
  const prefix = `gitwiki.draft:${repo}:`;
  const entries = Object.keys(localStorage).filter(k => k === prefix + from || k.startsWith(prefix + from + "/"));
  const copies = entries.map(old => {
    const next = prefix + to + old.slice((prefix + from).length);
    const data = localStorage.getItem(old);
    if (localStorage.getItem(next) !== null) throw new Error("新位置已有本机草稿，旧草稿已保留");
    return { old, next, data };
  });
  // Keep every original until all destination writes succeed (including quota failures).
  for (const { next, data } of copies) if (data !== null) localStorage.setItem(next, data);
  for (const { old } of copies) localStorage.removeItem(old);
}

export function loadDraft(repo: string, id: string): Draft | null {
  try {
    const s = localStorage.getItem(key(repo, id));
    return s ? (JSON.parse(s) as Draft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(repo: string, id: string, d: Draft) {
  try { localStorage.setItem(key(repo, id), JSON.stringify(d)); return true; } catch { return false; /* storage full or blocked */ }
}

export function clearDraft(repo: string, id: string) {
  try { localStorage.removeItem(key(repo, id)); } catch { /* blocked */ }
}
