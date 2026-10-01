import { toast } from "sonner";
import { api } from "./api";
import { clearDraft } from "./draft";
import { HOME } from "./route";
import { parentOf } from "./tree";
import { useStore } from "../store";

// Page operations shared by the sidebar (drag and drop) and the page menu.

// movePage moves id under parentId ("" for the top level). If the open page moved with it,
// the editor follows it to its new address.
export async function movePage(id: string, parentId: string) {
  const st = useStore.getState();
  const repo = st.currentRepo;
  const open = st.currentPageId;
  if (!repo) return;
  const affected = open !== null && (open === id || open.startsWith(id + "/"));
  if (affected && st.dirty) {
    toast.error("先保存或放弃当前页面的修改，再移动它");
    return;
  }
  try {
    const res = await api.movePage(repo, id, parentId);
    await useStore.getState().refreshTree();
    if (affected) useStore.getState().openPage(res.id + open.slice(id.length));
    toast.success(res.links_updated ? `已移动，更新了 ${res.links_updated} 个页面里的链接` : "已移动");
  } catch (e) {
    toast.error(`移动失败：${(e as Error).message}`);
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
