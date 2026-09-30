const jsonHeaders = { "Content-Type": "application/json" };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (r.status === 401) {
    // Redirect to login
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${r.status}: ${text || r.statusText}`);
  }
  return r.json();
}

export interface User { login: string; name: string; email: string }
export interface Repo { slug: string; title: string }
export interface PageMeta {
  id: string; title: string; is_dir: boolean; has_body: boolean; children?: PageMeta[]
}
export interface PageContent {
  id: string; title: string; body: string; base_sha: string; is_bundle: boolean;
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

export interface AssetUpload { path: string }

export const api = {
  me: () => req<{ user: User | null }>("/api/me"),
  repos: () => req<Repo[]>("/api/repos"),
  pageTree: (slug: string) => req<PageMeta>(`/api/repos/${slug}/pages`),
  readPage: (slug: string, id: string) =>
    req<PageContent>(`/api/repos/${slug}/page?id=${encodeURIComponent(id)}`),
  savePage: async (slug: string, p: { id: string; title: string; body: string; base_sha: string; message?: string }) => {
    const r = await fetch(`/api/repos/${slug}/page`, {
      method: "PUT", headers: jsonHeaders, body: JSON.stringify(p),
    });
    if (r.status === 401) { window.location.href = "/login"; throw new Error("unauthorized"); }
    if (r.status === 409) {
      const data = (await r.json()) as ConflictResult;
      return data;
    }
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as SaveResult;
  },
  createPage: (slug: string, p: { parent_id?: string; title: string }) =>
    req<{ id: string }>(`/api/repos/${slug}/page`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(p) }),
  deletePage: (slug: string, id: string) =>
    req<{ status: string }>(`/api/repos/${slug}/page?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  reorderPages: (slug: string, parentId: string, orderedIds: string[]) =>
    req<{ status: string }>(`/api/repos/${slug}/order`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ parent_id: parentId, ordered_ids: orderedIds }) }),
  retitlePage: (slug: string, id: string, title: string) =>
    req<{ id: string; commit_sha: string }>(`/api/repos/${slug}/page`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ id, title }) }),
  listAssets: (slug: string, pageId: string) =>
    req<string[]>(`/api/repos/${slug}/assets?page_id=${encodeURIComponent(pageId)}`),
  assetUrl: (slug: string, pageId: string, name: string) =>
    `/api/repos/${slug}/asset?page_id=${encodeURIComponent(pageId)}&name=${encodeURIComponent(name)}`,
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
          catch { reject(new Error("bad json from server")); }
        } else {
          reject(new Error(xhr.responseText || `http ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(fd);
    }),
};
