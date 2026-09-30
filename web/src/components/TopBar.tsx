import { useState, useEffect } from "react";
import { useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { RefreshCw, Check, AlertTriangle, Loader2, Pencil, ChevronUp, ChevronDown, Trash2, Plus } from "lucide-react";
import { connectPresence } from "../lib/ws";
import { toast } from "sonner";

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
  const clearSavedBanner = useStore(s => s.clearSavedBanner);
  const tree = useStore(s => s.tree);

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const ctx = findNode(tree, currentPageId);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 2500);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  if (!user) return null;

  const handleRefresh = async () => {
    if (!currentRepo || !currentPageId) return;
    const pc = await api.readPage(currentRepo, currentPageId);
    useStore.getState().openPage(pc.id, pc.base_sha, pc.is_bundle);
    clearSavedBanner();
    connectPresence(currentRepo, currentPageId);
  };

  const refreshTree = async () => {
    if (!currentRepo) return;
    const t = await api.pageTree(currentRepo);
    useStore.getState().setTree(t);
  };

  const onRename = async () => {
    if (!currentRepo || !ctx || !renameVal.trim() || renameVal === ctx.node.title) {
      setRenaming(false);
      return;
    }
    try {
      await api.retitlePage(currentRepo, ctx.node.id, renameVal.trim());
      await refreshTree();
      toast.success("已重命名");
    } catch (e: any) { toast.error(`重命名失败: ${e.message}`); }
    setRenaming(false);
  };

  const onDelete = async () => {
    if (!currentRepo || !ctx) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    try {
      await api.deletePage(currentRepo, ctx.node.id);
      await refreshTree();
      useStore.getState().closePage();
      toast.success("已删除");
    } catch (e: any) {
      toast.error(`删除失败: ${e.message}`);
      setConfirmDelete(false);
    }
  };

  const move = async (dir: -1 | 1) => {
    if (!currentRepo || !ctx) return;
    const j = ctx.index + dir;
    if (j < 0 || j >= ctx.siblings.length) return;
    const next = [...ctx.siblings];
    [next[ctx.index], next[j]] = [next[j], next[ctx.index]];
    try {
      await api.reorderPages(currentRepo, ctx.parentId, next.map(x => x.id));
      await refreshTree();
    } catch (e: any) { toast.error(`排序失败: ${e.message}`); }
  };

  return (
    <header className="h-11 bg-white border-b border-stone-200 flex items-center px-4 gap-2 text-sm shrink-0">
      <div className="text-xs text-stone-500 font-mono truncate max-w-xs">
        {currentPageId ?? ""}
      </div>

      {/* Page actions (only when a page is open) */}
      {ctx && (
        <div className="flex items-center gap-0.5 ml-2 pl-2 border-l border-stone-200">
          <IconBtn title="新建子页面" onClick={async () => {
            const title = prompt("子页面标题");
            if (!title || !currentRepo) return;
            try {
              const res = await api.createPage(currentRepo, { parent_id: ctx.node.id, title });
              await refreshTree();
              // Auto-open
              const pc = await api.readPage(currentRepo, res.id);
              useStore.getState().openPage(pc.id, pc.base_sha, pc.is_bundle);
              toast.success("已创建子页面");
            } catch (e: any) { toast.error(`创建失败: ${e.message}`); }
          }}><Plus className="size-3.5" /></IconBtn>
          <IconBtn title="重命名" onClick={() => { setRenameVal(ctx.node.title); setRenaming(true); }}>
            <Pencil className="size-3.5" />
          </IconBtn>
          <IconBtn title="上移" onClick={() => void move(-1)} disabled={ctx.index === 0}>
            <ChevronUp className="size-3.5" />
          </IconBtn>
          <IconBtn title="下移" onClick={() => void move(1)} disabled={ctx.index === ctx.siblings.length - 1}>
            <ChevronDown className="size-3.5" />
          </IconBtn>
          <IconBtn
            title={confirmDelete ? "再点一次确认删除" : "删除"}
            onClick={onDelete}
            className={confirmDelete ? "bg-red-500 text-white hover:bg-red-600" : "text-red-500 hover:bg-red-50"}
          >
            <Trash2 className="size-3.5" />
          </IconBtn>
        </div>
      )}

      <div className="flex-1" />

      {lastSavedBy && lastSavedBy !== user.login && (
        <button
          onClick={handleRefresh}
          className="group inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition"
        >
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="font-medium">{lastSavedBy}</span> 保存了新版本
          <RefreshCw className="size-3 opacity-50 group-hover:opacity-100" />
        </button>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />

      {renaming && (
        <div className="fixed inset-0 bg-black/40 z-30 flex items-start justify-center pt-32 backdrop-blur-sm" onClick={() => setRenaming(false)}>
          <div className="bg-white rounded-xl w-96 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-stone-100">
              <h3 className="font-semibold text-sm">重命名</h3>
            </div>
            <div className="px-5 py-4">
              <input
                autoFocus
                className="w-full rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40"
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            </div>
            <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={() => setRenaming(false)} className="px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100 rounded">取消</button>
              <button onClick={onRename} className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">确定</button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

function IconBtn({ title, onClick, disabled, className, children }: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={
        "p-1.5 rounded text-stone-500 hover:bg-stone-100 hover:text-stone-800 disabled:opacity-25 disabled:hover:bg-transparent transition " +
        (className ?? "")
      }
    >
      {children}
    </button>
  );
}

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  if (status === "saving") {
    return <div className="inline-flex items-center gap-1.5 text-xs text-stone-500"><Loader2 className="size-3 animate-spin" />保存中</div>;
  }
  if (status === "saved") {
    return <div className="inline-flex items-center gap-1.5 text-xs text-emerald-700"><Check className="size-3.5" />已保存</div>;
  }
  if (status === "conflict") {
    return <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium"><AlertTriangle className="size-3" />有冲突</div>;
  }
  if (status === "error") {
    return <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium">出错</div>;
  }
  if (dirty) return <div className="text-xs text-stone-400">未保存</div>;
  return null;
}
