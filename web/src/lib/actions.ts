import { toast } from "sonner";
import { api } from "./api";
import { clearDraft, moveDrafts } from "./draft";
import { moveRecentPages } from "./recents";
import { HOME } from "./route";
import { pagePath, parentOf } from "./tree";
import { useStore } from "../store";

// Page operations shared by the sidebar (drag and drop) and the page menu.

export function followPageMove(repo: string, from: string, to: string) {
  if (from === to) return;
  try {
    moveDrafts(repo, from, to);
    moveRecentPages(repo, from, to);
  } catch (e) {
    toast.error(`页面已移动，本机记录未能更新：${(e as Error).message}`);
    return;
  }
  const st = useStore.getState();
  const open = st.currentPageId;
  if (st.currentRepo !== repo || open === null) return;
  if (open === from || open.startsWith(from + "/")) {
    const dirty = st.dirty;
    const detail = { repo, from, to, ok: true };
    window.dispatchEvent(new CustomEvent("gitwiki:page-moved", { detail }));
    if (!detail.ok) {
      toast.error("页面已移动，但本机草稿保存失败，请先复制未保存内容");
      return;
    }
    st.markDirty(false);
    st.openPage(to + open.slice(from.length));
    if (dirty) toast.info("页面已移动，未保存修改已保留为本机草稿，请恢复后检查再保存");
  } else if (!st.dirty) {
    st.reloadPage(); // links in other open pages may have changed too
  } else {
    st.onSaved(""); // retain edits and show the existing stale-content warning
  }
}

// movePage moves id under parentId ("" for the top level) and resolves to its new id (null if
// it did not move). If the open page moved with it, the editor follows it to its new address.
export async function movePage(id: string, parentId: string): Promise<string | null> {
  const st = useStore.getState();
  const repo = st.currentRepo;
  const open = st.currentPageId;
  if (!repo) return null;
  const affected = open !== null && (open === id || open.startsWith(id + "/"));
  if (affected && st.dirty) {
    toast.error("先保存或放弃当前页面的修改，再移动它");
    return null;
  }
  try {
    const res = await api.movePage(repo, id, parentId);
    followPageMove(repo, id, res.id);
    await useStore.getState().refreshTree();
    toast.success(res.links_updated ? `已移动，更新了 ${res.links_updated} 个页面里的链接` : "已移动");
    return res.id;
  } catch (e) {
    toast.error(`移动失败：${(e as Error).message}`);
    return null;
  }
}

// placePage puts id right before or after the page beside, moving it under that page's parent
// first when it lives elsewhere. Order is kept as `weight`, which only page files can carry:
// folders without one keep their place at the end.
export async function placePage(id: string, beside: string, after: boolean) {
  const repo = useStore.getState().currentRepo;
  const parent = parentOf(beside);
  if (!repo) return;
  const placed = parentOf(id) === parent ? id : await movePage(id, parent);
  if (!placed) return;
  const tree = useStore.getState().tree;
  const siblings = (parent ? pagePath(tree, parent).at(-1)?.children : tree?.children) ?? [];
  const ids = siblings.filter(n => n.has_body && n.id !== placed).map(n => n.id);
  const at = ids.indexOf(beside);
  ids.splice(at < 0 ? ids.length : at + (after ? 1 : 0), 0, placed);
  if (ids.join() === siblings.filter(n => n.has_body).map(n => n.id).join()) return;
  try {
    await api.reorderPages(repo, parent, ids);
    await useStore.getState().refreshTree();
  } catch (e) {
    toast.error(`排序失败：${(e as Error).message}`);
  }
}

// deletePage deletes id with everything under it. If the open page went with it, its parent
// (or the home page) opens instead.
export async function deletePage(id: string): Promise<boolean> {
  const st = useStore.getState();
  const repo = st.currentRepo;
  const open = st.currentPageId;
  if (!repo) return false;
  try {
    await api.deletePage(repo, id);
    clearDraft(repo, id);
    await useStore.getState().refreshTree();
    if (open !== null && (open === id || open.startsWith(id + "/"))) {
      useStore.getState().markDirty(false); // the page is gone: nothing left to keep
      useStore.getState().openPage(parentOf(id) || HOME);
    }
    toast.success("已删除，可以在首页的“最近更新”里恢复");
    return true;
  } catch (e) {
    toast.error(`删除失败：${(e as Error).message}`);
    return false;
  }
}
