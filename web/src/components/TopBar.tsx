import { useState, useEffect, useRef, type ReactNode } from "react";
import { useCanWrite, useStore } from "../store";
import { api, type PageMeta, type PageRef } from "../lib/api";
import { descendants, pagePath, parentOf } from "../lib/tree";
import { HOME } from "../lib/route";
import { deletePage, movePage } from "../lib/actions";
import {
  RefreshCw, Check, AlertTriangle, Loader2, Pencil, ArrowUp, ArrowDown, Trash2, Plus,
  MoreHorizontal, Menu, ChevronRight, CloudOff, FolderInput, Eye,
} from "lucide-react";
import { toast } from "sonner";
import { NewPageDialog } from "./Sidebar";
import { PagePicker } from "./PagePicker";
import { btnGhost, btnPrimary, iconBtn, overlay } from "./ui";

interface Ctx { node: PageMeta; parentId: string; siblings: PageMeta[]; index: number }

function findNode(tree: PageMeta | null, id: string | null, parentId = "", siblings: PageMeta[] = []): Ctx | null {
  if (!tree || !id) return null;
  // root itself has no ops
  const visit = (n: PageMeta, parent: string, kids: PageMeta[], idx: number): Ctx | null => {
    if (n.id === id) return { node: n, parentId: parent, siblings: kids, index: idx };
    for (let i = 0; i < (n.children?.length ?? 0); i++) {
      const r = visit(n.children![i], n.id, n.children!, i);
      if (r) return r;
    }
    return null;
  };
  return visit(tree, parentId, siblings, 0);
}

export function TopBar() {
  const user = useStore(s => s.user);
  const currentRepo = useStore(s => s.currentRepo);
  const saveStatus = useStore(s => s.saveStatus);
  const dirty = useStore(s => s.dirty);
  const lastSavedBy = useStore(s => s.lastSavedBy);
  const currentPageId = useStore(s => s.currentPageId);
  const tree = useStore(s => s.tree);
  const openPage = useStore(s => s.openPage);
  const setNavOpen = useStore(s => s.setNavOpen);
  const syncError = useStore(s => s.syncError);
  const canWrite = useCanWrite();

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [dialog, setDialog] = useState<"create" | "move" | "delete" | null>(null);

  if (!user) return null;

  const ctx = findNode(tree, currentPageId);
  const path = pagePath(tree, currentPageId);

  // Remounts the editor so body and base_sha are refetched together. Keeping the old body
  // with the new base_sha would make the next save silently overwrite the other edit.
  const handleRefresh = () => {
    if (dirty && !confirm("载入新版本后，你未保存的修改会留在本机草稿里，可以再恢复。继续？")) return;
    useStore.getState().reloadPage();
  };

  const onRename = async () => {
    if (!currentRepo || !ctx || !renameVal.trim() || renameVal === ctx.node.title) {
      setRenaming(false);
      return;
    }
    try {
      await api.retitlePage(currentRepo, ctx.node.id, renameVal.trim());
      await useStore.getState().refreshTree();
      toast.success("已重命名");
    } catch (e: any) { toast.error(`重命名失败：${e.message}`); }
    setRenaming(false);
  };

  const reorder = async (dir: -1 | 1) => {
    if (!currentRepo || !ctx) return;
    const j = ctx.index + dir;
    if (j < 0 || j >= ctx.siblings.length) return;
    const next = [...ctx.siblings];
    [next[ctx.index], next[j]] = [next[j], next[ctx.index]];
    try {
      await api.reorderPages(currentRepo, ctx.parentId, next.map(x => x.id));
      await useStore.getState().refreshTree();
    } catch (e: any) { toast.error(`排序失败：${e.message}`); }
  };

  return (
    <header className="h-12 shrink-0 bg-white border-b border-stone-200 flex items-center gap-1.5 px-2 sm:px-4 text-sm">
      <button onClick={() => setNavOpen(true)} title="页面列表" className={`${iconBtn} md:hidden`}>
        <Menu className="size-4" />
      </button>

      {/* Breadcrumb of titles; ancestors collapse on narrow screens. */}
      <nav className="flex-1 min-w-0 flex items-center gap-1" aria-label="当前位置">
        {path.slice(0, -1).map(n => (
          <span key={n.id} className="hidden sm:flex items-center gap-1 min-w-0 shrink">
            <button
              onClick={() => n.has_body && openPage(n.id)}
              disabled={!n.has_body}
              className="truncate max-w-[12rem] rounded px-1 py-0.5 text-stone-500 enabled:hover:text-stone-900 enabled:hover:bg-stone-100 transition"
            >{n.title}</button>
            <ChevronRight className="size-3.5 shrink-0 text-stone-300" />
          </span>
        ))}
        {path.length > 0 && (
          <span className="truncate px-1 font-medium text-stone-900">{path[path.length - 1].title}</span>
        )}
        {currentPageId === HOME && <span className="truncate px-1 font-medium text-stone-900">首页</span>}
      </nav>

      {lastSavedBy !== null && lastSavedBy !== user.login && (
        <button
          onClick={handleRefresh}
          title="载入新版本"
          className="group inline-flex items-center gap-1.5 h-7 shrink-0 text-xs px-2.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition"
        >
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          {lastSavedBy ? (
            <>
              <span className="font-medium max-w-[6rem] truncate">{lastSavedBy}</span>
              <span className="hidden sm:inline">更新了本页</span>
            </>
          ) : (
            <span>这页有新版本</span>
          )}
          <RefreshCw className="size-3 opacity-60 group-hover:opacity-100" />
        </button>
      )}

      {/* Why syncing failed is for us (the server logs it); readers only need to know their work is safe. */}
      {syncError && (
        <span
          title="修改都已保存，只是暂时没能同步到站点，会自动重试"
          className="inline-flex items-center gap-1.5 h-7 shrink-0 text-xs px-2.5 rounded-full bg-red-50 text-red-700 border border-red-200"
        >
          <CloudOff className="size-3.5" /><span className="hidden sm:inline">同步失败</span>
        </span>
      )}

      {!canWrite && (
        <span
          title="你可以阅读，但没有编辑权限"
          className="inline-flex items-center gap-1 h-7 shrink-0 text-xs px-2.5 rounded-full bg-stone-100 text-stone-600"
        >
          <Eye className="size-3.5" />只读
        </span>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />

      {/* Editor portals the page's own actions (编辑 / 保存 / 历史 / 附件) in here. */}
      <div id="page-actions" className="flex items-center gap-1 shrink-0" />

      {ctx && canWrite && (
        <MoreMenu items={[
          { label: "新建子页面", icon: <Plus />, onClick: () => setDialog("create") },
          { label: "重命名", icon: <Pencil />, onClick: () => { setRenameVal(ctx.node.title); setRenaming(true); } },
          { label: "移动到…", icon: <FolderInput />, onClick: () => setDialog("move") },
          { label: "上移", icon: <ArrowUp />, onClick: () => void reorder(-1), disabled: ctx.index === 0 },
          { label: "下移", icon: <ArrowDown />, onClick: () => void reorder(1), disabled: ctx.index === ctx.siblings.length - 1 },
          { label: "删除页面", icon: <Trash2 />, onClick: () => setDialog("delete"), danger: true },
        ]} />
      )}

      {dialog === "create" && ctx && <NewPageDialog parentId={ctx.node.id} onClose={() => setDialog(null)} />}
      {dialog === "move" && ctx && (
        <PagePicker
          title={`把「${ctx.node.title}」移动到…`}
          hint="连同子页面和附件一起移动，其他页面里指向它的链接会自动更新"
          top="顶层"
          disabled={(id) => id === ctx.node.id || id.startsWith(ctx.node.id + "/") || id === parentOf(ctx.node.id)}
          onClose={() => setDialog(null)}
          onPick={(p) => { setDialog(null); void movePage(ctx.node.id, p.id); }}
        />
      )}
      {dialog === "delete" && ctx && <DeleteDialog node={ctx.node} onClose={() => setDialog(null)} />}

      {renaming && (
        <div className={`${overlay} flex items-start justify-center pt-[18vh] px-4`} onClick={() => setRenaming(false)}>
          <div className="bg-white rounded-xl w-full max-w-sm shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="font-semibold text-sm text-stone-900">重命名</h3>
              <p className="text-xs text-stone-500 mt-0.5">只改标题，页面地址不变</p>
            </div>
            <div className="px-5 pb-4">
              <input
                autoFocus
                className="w-full rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            </div>
            <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={() => setRenaming(false)} className={btnGhost}>取消</button>
              <button onClick={() => void onRename()} className={btnPrimary}>确定</button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

// Deleting takes the page's children and attachments along; pages that link into it are
// listed first, since those links break.
function DeleteDialog({ node, onClose }: { node: PageMeta; onClose(): void }) {
  const repo = useStore(s => s.currentRepo);
  const [refs, setRefs] = useState<PageRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const kids = descendants(node);

  useEffect(() => {
    if (!repo) return;
    api.backlinks(repo, node.id, true).then(setRefs, () => setRefs([]));
  }, [repo, node.id]);

  return (
    <div className={`${overlay} flex items-start justify-center pt-[18vh] px-4`} onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4 space-y-2 text-sm text-stone-600">
          <h3 className="font-semibold text-stone-900">删除「{node.title}」？</h3>
          <p>
            {kids > 0 ? <>会一起删除它下面的 <b className="font-semibold text-stone-900">{kids}</b> 个子页面和所有附件。</> : "会一起删除它的附件。"}
            删除后可以在首页的“最近更新”里恢复。
          </p>
          {refs === null && <p className="text-xs text-stone-400">正在检查哪些页面链接到这里…</p>}
          {!!refs?.length && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
              <p>有 {refs.length} 个页面链接到这里，删除后这些链接会失效：</p>
              <ul className="mt-1 list-disc pl-5 text-[13px]">
                {refs.slice(0, 5).map(r => <li key={r.id} className="truncate">{r.title}</li>)}
                {refs.length > 5 && <li>…等 {refs.length} 个</li>}
              </ul>
            </div>
          )}
        </div>
        <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
          <button onClick={onClose} className={btnGhost}>取消</button>
          <button
            disabled={busy}
            onClick={async () => { setBusy(true); if (await deletePage(node.id)) onClose(); else setBusy(false); }}
            className={`${btnPrimary} bg-red-600 hover:bg-red-700`}
          >{busy ? "删除中…" : "删除"}</button>
        </div>
      </div>
    </div>
  );
}

interface MenuItem { label: string; icon: ReactNode; onClick(): void; disabled?: boolean; danger?: boolean }

function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen(o => !o)} title="更多操作" aria-haspopup="menu" aria-expanded={open} className={iconBtn}>
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 z-30 w-44 rounded-lg border border-stone-200 bg-white p-1 shadow-lg">
          {items.map(it => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={
                "w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-left transition disabled:opacity-35 disabled:pointer-events-none [&>svg]:size-3.5 " +
                (it.danger ? "text-red-600 hover:bg-red-50 mt-1 border-t border-stone-100 rounded-t-none pt-2" : "text-stone-700 hover:bg-stone-100")
              }
            >
              {it.icon}{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  const base = "inline-flex items-center gap-1.5 shrink-0 text-xs";
  if (status === "saving") {
    return <div className={`${base} text-stone-500`}><Loader2 className="size-3.5 animate-spin" /><span className="hidden sm:inline">保存中</span></div>;
  }
  if (status === "saved") {
    return <div className={`${base} text-emerald-700`}><Check className="size-3.5" /><span className="hidden sm:inline">已保存</span></div>;
  }
  if (status === "conflict") {
    return <div className={`${base} px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium`}><AlertTriangle className="size-3" />有冲突</div>;
  }
  if (status === "error") {
    return <div className={`${base} px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium`}>保存出错</div>;
  }
  if (dirty) return <div className={`${base} text-stone-400`}><span className="size-1.5 rounded-full bg-stone-400" /><span className="hidden sm:inline">未保存</span></div>;
  return null;
}
