import { pathFor } from "./route";

const jsonHeaders = { "Content-Type": "application/json" };

// The GitHub login, coming back to the page that was open.
export function loginUrl(): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

// ApiError's message is for the person using the wiki. What the server said (often an internal
// detail) only goes to the console, for us.
export class ApiError extends Error {
  status: number;
  constructor(status: number, detail = "") {
    super(friendly(status, detail.trim()));
    this.status = status;
    if (detail.trim()) console.warn(`api ${status}: ${detail.trim()}`);
  }
}

function friendly(status: number, detail: string): string {
  if (status === 401) return "请重新登录后再试";
  if (status === 403) return "没有权限做这个操作";
  if (status === 404) return "页面不存在，可能已被删除或移动";
  if (status === 409) return /\p{Script=Han}/u.test(detail) ? detail : "和别人的修改冲突了，请刷新后再试";
  if (status >= 500) return "服务出了点问题，请稍后再试";
  return "操作没有成功，请刷新后再试";
}

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;

const offline = () => new Error("网络连接失败，请检查网络后重试");

async function call(path: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(path, init).catch(() => { throw offline(); });
  if (r.status === 401) {
    // Writing while logged out bounces to login; for reads the repo simply is not public:
    // the router-level 401 page carries the login button instead of a redirect loop here.
    throw new ApiError(401, await r.text().catch(() => ""));
  }
  return r;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await call(path, init);
  if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ""));
  return r.json();
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
const q = encodeURIComponent;

export interface User { login: string; name: string; email: string }
export interface SyncStatus {
  last_pull?: string; pending: number; running: boolean; queued: boolean;
  pull_error?: string; push_error?: string;
}
// A wiki: a GitHub repo the App is installed on, slug "owner/repo". can_write: the user may push
// to it; without it the wiki is read-only for them.
export interface Repo { slug: string; title: string; can_write: boolean }
// The wiki's own settings, from .gitwiki/config.yaml in its repo (defaults filled in).
export interface Settings { title: string; read_public: boolean; site_url?: string; source?: string[]; stale_days: number }
export interface PageMeta {
  id: string; title: string; is_dir: boolean; has_body: boolean;
  tags?: string[]; draft?: boolean; deprecated?: boolean; children?: PageMeta[];
}
// Front matter fields the properties panel edits. owner: GitHub login of who keeps the page up
// to date; reviewed: the day they last confirmed it as still right without changing it.
export interface Meta {
  tags: string[]; draft: boolean; description: string; date: string; deprecated?: boolean; replaced_by?: string;
  owner?: string; reviewed?: string;
}
export interface PageContent {
  id: string; title: string; body: string; meta: Meta; base_sha: string; is_bundle: boolean;
  last_author?: string; last_commit_sha?: string; last_commit_at?: string;
}
export interface SaveResult { commit_sha: string }
export interface ConflictResult {
  conflict: true;
  merged: string;      // merged whole file (front matter + body, with conflict markers)
  current_sha: string;
  theirs_body: string; // body at current HEAD
  ours_body: string;   // the body the user tried to save
  base_body: string;   // body of the base version
}
// links_only: another page moved and this one only had its links to it updated.
export interface Revision { sha: string; author: string; date: string; message: string; links_only?: boolean }
export interface RevisionContent { title: string; body: string; meta: Meta }
export interface Change {
  id: string; title: string; sha: string; author: string; date: string; message: string;
  deleted?: boolean; // the change deleted the page; restorePage(id, sha) undoes it
}
export interface PageRef { id: string; title: string }
export interface SearchHit { page_id: string; title: string; snippet: string; terms: string[]; deprecated?: boolean }
export interface PageTemplate { id: string; title: string; description: string; body: string }
// updated: the last commit, sent while stale pages are checked (stale_days > 0).
export interface HealthPage { id: string; title: string; file: string; body: string; meta: Meta; updated?: string }
export interface HealthSnapshot { pages: HealthPage[]; files: string[]; stale_days?: number }
export interface SearchFilters { directory?: string; tag?: string; draft?: string; updated_after?: string }
export interface AssetUpload { path: string }
export interface CommentAnchor {
  quote: string; prefix: string; suffix: string; start_raw: number; end_raw: number;
}
export interface Comment {
  id: string; by: string; name: string; at: string; text: string; anchor?: CommentAnchor;
}

export const api = {
  // repos: the configured repos the user can read (present when logged in).
  me: () => req<{ user: User | null; repos?: Repo[] }>("/api/me"),
  syncStatus: (slug: string) => req<SyncStatus>(`/api/repos/${slug}/sync`),
  syncNow: (slug: string) => req<SyncStatus>(`/api/repos/${slug}/sync`, post({})),
  settings: (slug: string) => req<Settings>(`/api/repos/${slug}/settings`),
  pageTree: (slug: string) => req<PageMeta>(`/api/repos/${slug}/pages`),
  templates: (slug: string) => req<PageTemplate[]>(`/api/repos/${slug}/templates`),
  health: (slug: string) => req<HealthSnapshot>(`/api/repos/${slug}/health`),
  readPage: (slug: string, id: string) => req<PageContent>(`/api/repos/${slug}/page?id=${q(id)}`),
  savePage: async (slug: string, p: { id: string; title: string; body: string; meta?: Meta; base_sha: string; message?: string }) => {
    const r = await call(`/api/repos/${slug}/page`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify(p) });
    if (r.status === 409) return (await r.json()) as ConflictResult;
    if (!r.ok) throw new ApiError(r.status, await r.text().catch(() => ""));
    return (await r.json()) as SaveResult;
  },
  createPage: (slug: string, p: { parent_id?: string; title: string; template?: string }) =>
    req<{ id: string }>(`/api/repos/${slug}/page`, post(p)),
  // Deletes the page with its children and attachments; restorePage brings them back.
  deletePage: (slug: string, id: string) =>
    req<{ status: string }>(`/api/repos/${slug}/page?id=${q(id)}`, { method: "DELETE" }),
  movePage: (slug: string, id: string, parentId: string) =>
    req<{ id: string; links_updated: number }>(`/api/repos/${slug}/move`, post({ id, parent_id: parentId })),
  restorePage: (slug: string, id: string, sha: string) =>
    req<{ id: string }>(`/api/repos/${slug}/restore`, post({ id, sha })),
  reorderPages: (slug: string, parentId: string, orderedIds: string[]) =>
    req<{ status: string }>(`/api/repos/${slug}/order`, post({ parent_id: parentId, ordered_ids: orderedIds })),
  // Renames tag from to to on every page that has it (to "": removes it); with pages, adds
  // (from "") or removes it on those pages only. Resolves to the pages changed.
  retag: (slug: string, from: string, to: string, pages?: string[]) =>
    req<{ pages: string[] }>(`/api/repos/${slug}/tags`, post({ from, to, pages })),
  retitlePage: (slug: string, id: string, title: string) =>
    req<{ id: string; commit_sha: string }>(`/api/repos/${slug}/page`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ id, title }) }),
  history: (slug: string, id: string) => req<Revision[]>(`/api/repos/${slug}/history?id=${q(id)}`),
  revision: (slug: string, id: string, sha: string) =>
    req<RevisionContent>(`/api/repos/${slug}/revision?id=${q(id)}&sha=${q(sha)}`),
  recent: (slug: string) => req<Change[]>(`/api/repos/${slug}/recent`),
  // subtree: also pages linking to any page under id.
  backlinks: (slug: string, id: string, subtree = false) =>
    req<PageRef[]>(`/api/repos/${slug}/backlinks?id=${q(id)}${subtree ? "&subtree=1" : ""}`),
  search: (slug: string, query: string, filters: SearchFilters = {}) => {
    const params = new URLSearchParams({ q: query });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return req<SearchHit[]>(`/api/repos/${slug}/search?${params}`);
  },
  trash: (slug: string) => req<Change[]>(`/api/repos/${slug}/trash`),
  comments: (slug: string, pageId: string) => req<Comment[]>(`/api/repos/${slug}/comments?page_id=${q(pageId)}`),
  postComment: (slug: string, body: { page_id: string; text: string; anchor?: CommentAnchor; save: boolean }) =>
    req<Comment>(`/api/repos/${slug}/comments`, post(body)),
  importPage: (slug: string, p: { parent_id?: string; title: string; type: string; file: File }) => {
    const fd = new FormData();
    fd.append("title", p.title);
    fd.append("type", p.type);
    fd.append("file", p.file);
    if (p.parent_id) fd.append("parent_id", p.parent_id);
    return req<{ id: string }>(`/api/repos/${slug}/import`, { method: "POST", body: fd });
  },
  copyPage: (slug: string, id: string, parentId?: string) =>
    req<{ id: string }>(`/api/repos/${slug}/copy`, post({ id, parent_id: parentId ?? "" })),
  // Link the user can share: /owner/repo/page.md (/owner/repo.md for the home page), which the
  // server answers with the page's source.
  mdUrl: (slug: string, id: string) => pathFor(slug, id) + ".md",
  listAssets: (slug: string, pageId: string) =>
    req<string[]>(`/api/repos/${slug}/assets?page_id=${q(pageId)}`),
  deleteAsset: (slug: string, pageId: string, name: string) =>
    req<{ status: string }>(`/api/repos/${slug}/asset?page_id=${q(pageId)}&name=${q(name)}`, { method: "DELETE" }),
  assetUrl: (slug: string, pageId: string, name: string) =>
    `/api/repos/${slug}/asset?page_id=${q(pageId)}&name=${q(name)}`,
  // uploadAsset with progress. fetch() can't observe upload progress; use XHR.
  uploadAsset: (slug: string, pageId: string, file: File, onProgress?: (pct: number) => void): Promise<AssetUpload> =>
    new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append("page_id", pageId);
      fd.append("file", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/repos/${slug}/assets`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new ApiError(500, "bad json from server")); }
        } else {
          reject(new ApiError(xhr.status, xhr.responseText));
        }
      };
      xhr.onerror = () => reject(offline());
      xhr.send(fd);
    }),
};
