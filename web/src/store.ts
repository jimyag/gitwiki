import { create } from "zustand";
import type { PageMeta, Repo, User } from "./lib/api";

export type SaveStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export interface Peer { user: string; name: string; page: string; since: number }

interface State {
  user: User | null;
  repos: Repo[];
  currentRepo: string | null;
  tree: PageMeta | null;
  currentPageId: string | null;
  baseSha: string;
  isBundle: boolean;
  dirty: boolean;
  saveStatus: SaveStatus;
  peers: Peer[];
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
  repos: [],
  currentRepo: null,
  tree: null,
  currentPageId: null,
  baseSha: "",
  isBundle: false,
  dirty: false,
  saveStatus: "idle",
  peers: [],
  lastSavedBy: null,
  lastSavedSha: null,
  setUser: (user) => set({ user }),
  setRepos: (repos) => set({ repos }),
  setCurrentRepo: (currentRepo) => set({ currentRepo, tree: null, currentPageId: null, baseSha: "" }),
  setTree: (tree) => set({ tree }),
  openPage: (currentPageId, baseSha, isBundle) => set({ currentPageId, baseSha, isBundle, dirty: false, saveStatus: "idle" }),
  closePage: () => set({ currentPageId: null, baseSha: "", isBundle: false, dirty: false, saveStatus: "idle", peers: [] }),
  markDirty: (dirty) => set({ dirty }),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setPeers: (peers) => set({ peers }),
  onSaved: (lastSavedBy, lastSavedSha) => set({ lastSavedBy, lastSavedSha }),
  clearSavedBanner: () => set({ lastSavedBy: null, lastSavedSha: null }),
  bumpBaseSha: (baseSha) => set({ baseSha }),
}));
