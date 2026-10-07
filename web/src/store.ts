import { create } from "zustand";
import { api, type PageMeta, type Repo, type User } from "./lib/api";

export type SaveStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export type Panel = "assets" | "history" | "comments";

export interface Peer { user: string; name: string; page: string; since: number; editing?: boolean }

export interface RemoteCursor {
  user: string;
  anchor: number;
  head: number;
  color: string;
  at: number; // ms epoch, for staleness pruning
}

export interface UploadTask {
  id: string;
  filename: string;
  pct: number; // 0-100
  status: "uploading" | "done" | "error";
  error?: string;
}

interface State {
  user: User | null;
  uploads: UploadTask[];
  addUpload(u: UploadTask): void;
  updateUpload(id: string, patch: Partial<UploadTask>): void;
  removeUpload(id: string): void;
  repos: Repo[];
  currentRepo: string | null;
  tree: PageMeta | null;
  refreshTree(): Promise<void>;
  currentPageId: string | null;
  requestedLine: number;
  requestLine(line: number): void;
  // Bumped to make the editor refetch the current page (part of its React key).
  pageRev: number;
  baseSha: string;
  dirty: boolean;
  saveStatus: SaveStatus;
  peers: Peer[];
  setPeerEditing(user: string, editing: boolean): void;
  remoteCursors: Record<string, RemoteCursor>;
  setRemoteCursor(user: string, c: RemoteCursor): void;
  removeRemoteCursor(user: string): void;
  clearRemoteCursors(): void;
  // Who changed the open page since it loaded ("" for an edit pulled from GitHub); null if nobody.
  lastSavedBy: string | null;
  // Incremented when a "comments" ws message arrives for the open page; the panel refetches.
  commentsRev: number;
  bumpCommentsRev(): void;
  // Pages (any peer has commented on) for the sidebar comment badge.
  commentPeers: Record<string, string[]>;
  setCommentPeers(page: string, logins: string[]): void;
  // Why the server's background push to GitHub is failing; null once origin has everything.
  syncError: string | null;
  setSyncError(e: string | null): void;
  navOpen: boolean; // sidebar drawer on narrow screens
  setNavOpen(open: boolean): void;
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  tagsOpen: string | null; // the tag browser: null closed, "" all tags, else the selected tag
  setTagsOpen(tag: string | null): void;
  // The open page's panel: opened from the TopBar, rendered by the Editor that owns the page.
  panel: Panel | null;
  setPanel(p: Panel | null): void;
  setUser(u: User | null): void;
  setRepos(r: Repo[]): void;
  setTree(t: PageMeta | null): void;
  // The editor loads content and base_sha itself; callers only pick the page. Both return false
  // when the user chose to stay on a page with unsaved changes.
  openPage(id: string): boolean;
  // Shows repo + page in one update (used for URLs), so the URL sync never sees a half step.
  goTo(repo: string, page: string): boolean;
  reloadPage(): void;
  markDirty(d: boolean): void;
  setSaveStatus(s: SaveStatus): void;
  setPeers(p: Peer[]): void;
  onSaved(by: string): void;
  bumpBaseSha(sha: string): void;
}

// Unsaved edits also sit in a local draft, but leaving still deserves a question.
function leaveOk(dirty: boolean): boolean {
  return !dirty || confirm("这个页面有未保存的修改。离开后，下次打开它时可以从本机草稿恢复。确定离开？");
}

const pageReset = { baseSha: "", dirty: false, saveStatus: "idle" as SaveStatus, lastSavedBy: null, navOpen: false, commentPeers: {}, panel: null };

export const useStore = create<State>((set, get) => ({
  user: null,
  uploads: [],
  addUpload: (u) => set(s => ({ uploads: [...s.uploads, u] })),
  updateUpload: (id, patch) => set(s => ({
    uploads: s.uploads.map(u => u.id === id ? { ...u, ...patch } : u),
  })),
  removeUpload: (id) => set(s => ({ uploads: s.uploads.filter(u => u.id !== id) })),
  repos: [],
  currentRepo: null,
  tree: null,
  refreshTree: async () => {
    const repo = get().currentRepo;
    if (!repo) return;
    try {
      const tree = await api.pageTree(repo);
      if (get().currentRepo === repo) set({ tree });
    } catch (e: any) {
      // Anonymous visitor on a repo that isn't read_public: nothing to show, the editor
      // will surface a login hint instead of looping.
      if (e?.status !== 401 && e?.status !== 403) throw e;
    }
  },
  currentPageId: null,
  requestedLine: 0,
  requestLine: (requestedLine) => set({ requestedLine }),
  pageRev: 0,
  baseSha: "",
  dirty: false,
  saveStatus: "idle",
  peers: [],
  remoteCursors: {},
  setRemoteCursor: (user, c) => set(s => ({ remoteCursors: { ...s.remoteCursors, [user]: c } })),
  removeRemoteCursor: (user) => set(s => {
    const next = { ...s.remoteCursors };
    delete next[user];
    return { remoteCursors: next };
  }),
  clearRemoteCursors: () => set({ remoteCursors: {} }),
  lastSavedBy: null,
  syncError: null,
  setSyncError: (syncError) => set({ syncError }),
  navOpen: false,
  setNavOpen: (navOpen) => set({ navOpen }),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  tagsOpen: null,
  setTagsOpen: (tagsOpen) => set({ tagsOpen }),
  panel: null,
  setPanel: (panel) => set({ panel }),
  setUser: (user) => set({ user }),
  setRepos: (repos) => set({ repos }),
  setTree: (tree) => set({ tree }),
  openPage: (currentPageId) => {
    const s = get();
    if (currentPageId === s.currentPageId) return true;
    if (!leaveOk(s.dirty)) return false;
    set({ currentPageId, ...pageReset });
    return true;
  },
  goTo: (repo, currentPageId) => {
    const s = get();
    if (repo === s.currentRepo && currentPageId === s.currentPageId) return true;
    if (!leaveOk(s.dirty)) return false;
    set({ ...(repo !== s.currentRepo ? { currentRepo: repo, tree: null } : {}), currentPageId, ...pageReset });
    return true;
  },
  reloadPage: () => set(s => ({ pageRev: s.pageRev + 1, dirty: false, saveStatus: "idle", lastSavedBy: null })),
  markDirty: (dirty) => set({ dirty }),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setPeers: (peers) => set({ peers }),
  setPeerEditing: (user, editing) => set(s => ({
    peers: s.peers.map(p => p.user === user ? { ...p, editing } : p),
  })),
  commentsRev: 0,
  bumpCommentsRev: () => set(s => ({ commentsRev: s.commentsRev + 1 })),
  commentPeers: {},
  setCommentPeers: (page, logins) => set(s => ({
    commentPeers: { ...s.commentPeers, [page]: logins },
  })),
  onSaved: (lastSavedBy) => set({ lastSavedBy }),
  bumpBaseSha: (baseSha) => set({ baseSha }),
}));

// Whether the user may change the open repo. With read_public the server does not list the
// repo for logged-out readers; that absence is read-only.
export const useCanWrite = () => useStore(s => !!s.user && (s.repos.find(r => r.slug === s.currentRepo)?.can_write ?? false));
// urlRepo: when the open repo isn't in the (writable) repos list — either the user lacks push
// access or is logged out on a read_public repo — we still have a slug from the URL.
// A shared placeholder object keeps zustand's Object.is from re-rendering every store update
// (a fresh object each call is an infinite loop).
const urlRepo = new Map<string, Repo>();
const urlRepoFor = (slug: string): Repo => {
  let r = urlRepo.get(slug);
  if (!r) {
    r = { slug, title: slug, can_write: false };
    urlRepo.set(slug, r);
  }
  return r;
};
export const useRepoInfo = () => useStore(s => {
  const found = s.repos.find(r => r.slug === s.currentRepo);
  if (found) return found;
  return s.currentRepo ? urlRepoFor(s.currentRepo) : undefined;
});
