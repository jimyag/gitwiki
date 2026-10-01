import type { Meta } from "./api";

// Unsaved edits are mirrored to localStorage, so closing the tab, a crash or leaving the page
// does not lose them; the editor offers to restore a draft that differs from the saved page.
export interface Draft { title: string; body: string; meta: Meta; baseSha: string; at: number }

const key = (repo: string, id: string) => `gitwiki.draft:${repo}:${id}`;

export function loadDraft(repo: string, id: string): Draft | null {
  try {
    const s = localStorage.getItem(key(repo, id));
    return s ? (JSON.parse(s) as Draft) : null;
  } catch {
    return null;
  }
}

export function saveDraft(repo: string, id: string, d: Draft) {
  try { localStorage.setItem(key(repo, id), JSON.stringify(d)); } catch { /* storage full or blocked */ }
}

export function clearDraft(repo: string, id: string) {
  try { localStorage.removeItem(key(repo, id)); } catch { /* blocked */ }
}
