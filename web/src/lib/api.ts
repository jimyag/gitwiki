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
  id: string; content: string; base_sha: string; is_bundle: boolean;
}
export interface SaveResult { commit_sha: string }
export interface ConflictResult {
  conflict: true; merged: string; current_sha: string;
}

export interface AssetUpload { path: string }

export const api = {
  me: () => req<{ user: User | null }>("/api/me"),
  repos: () => req<Repo[]>("/api/repos"),
  pageTree: (slug: string) => req<PageMeta>(`/api/repos/${slug}/pages`),
  readPage: (slug: string, id: string) =>
    req<PageContent>(`/api/repos/${slug}/page?id=${encodeURIComponent(id)}`),
  savePage: async (slug: string, p: { id: string; content: string; base_sha: string; message?: string }) => {
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
  createPage: (slug: string, p: { parent_id?: string; slug: string; title: string }) =>
    req<{ id: string }>(`/api/repos/${slug}/page`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(p) }),
  deletePage: (slug: string, id: string) =>
    req<{ status: string }>(`/api/repos/${slug}/page?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  renamePage: (slug: string, oldId: string, newId: string) =>
    req<{ id: string }>(`/api/repos/${slug}/page`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ old_id: oldId, new_id: newId }) }),
  uploadAsset: async (slug: string, pageId: string, file: File): Promise<AssetUpload> => {
    const fd = new FormData();
    fd.append("page_id", pageId);
    fd.append("file", file, file.name);
    const r = await fetch(`/api/repos/${slug}/assets`, { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};
