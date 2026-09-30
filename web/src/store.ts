import { create } from "zustand";
import type { PageMeta, Repo, User } from "./lib/api";

export type SaveStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export interface Peer { user: string; name: string; page: string; since: number }

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
  currentPageId: string | null;
  baseSha: string;
  isBundle: boolean;
  dirty: boolean;
  saveStatus: SaveStatus;
  peers: Peer[];
  remoteCursors: Record<string, RemoteCursor>;
  setRemoteCursor(user: string, c: RemoteCursor): void;
  removeRemoteCursor(user: string): void;
  clearRemoteCursors(): void;
  lastSavedBy: string | null;
  lastSavedSha: string | null;
  setUser(u: User | null): void;
  setRepos(r: Repo[]): void;
  setCurrentRepo(s: string | null): void;
  setTree(t: PageMeta | null): void;
  openPage(id: string, base: string, isBundle: boolean): void;
  closePage(): void;
  markDirty(d: boolean): void;
  setSaveStatus(s: SaveStatus): void;
  setPeers(p: Peer[]): void;
  onSaved(by: string, sha: string): void;
  clearSavedBanner(): void;
  bumpBaseSha(sha: string): void;
}

export const useStore = create<State>((set) => ({
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
  currentPageId: null,
  baseSha: "",
  isBundle: false,
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
  lastSavedSha: null,
  setUser: (user) => set({ user }),
  setRepos: (repos) => set({ repos }),
  setCurrentRepo: (currentRepo) => set({ currentRepo, tree: null, currentPageId: null, baseSha: "" }),
  setTree: (tree) => set({ tree }),
  openPage: (currentPageId, baseSha, isBundle) => set({ currentPageId, baseSha, isBundle, dirty: false, saveStatus: "idle" }),
  closePage: () => set({ currentPageId: null, baseSha: "", isBundle: false, dirty: false, saveStatus: "idle", peers: [], remoteCursors: {} }),
  markDirty: (dirty) => set({ dirty }),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setPeers: (peers) => set({ peers }),
  onSaved: (lastSavedBy, lastSavedSha) => set({ lastSavedBy, lastSavedSha }),
  clearSavedBanner: () => set({ lastSavedBy: null, lastSavedSha: null }),
  bumpBaseSha: (baseSha) => set({ baseSha }),
}));
