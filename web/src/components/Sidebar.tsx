import { useState, useEffect, useRef } from "react";
import { useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { FileText, Folder, FolderOpen, Plus, ChevronRight, ChevronDown, ChevronUp, ChevronDown as ChevronDownIcon, Trash2, Pencil, BookOpen, LogOut } from "lucide-react";
import { toast } from "sonner";

// Stable color from user login. Used in avatar and cursor.
export function colorForUser(login: string): string {
  const palette = [
    ["#0ea5e9", "#0284c7"], // sky
    ["#8b5cf6", "#7c3aed"], // violet
    ["#f59e0b", "#d97706"], // amber
    ["#10b981", "#059669"], // emerald
    ["#ef4444", "#dc2626"], // red
    ["#ec4899", "#db2777"], // pink
    ["#14b8a6", "#0d9488"], // teal
    ["#f97316", "#ea580c"], // orange
  ];
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function Avatar({ login, size = 6 }: { login: string; size?: number }) {
  const cls = `rounded-full text-white flex items-center justify-center font-semibold shrink-0 size-${size}`;
  return (
    <div
      className={cls + " text-[10px]"}
      style={{ background: colorForUser(login) }}
      title={login}
    >
      {login.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function Sidebar() {
  const tree = useStore(s => s.tree);
  const repos = useStore(s => s.repos);
  const currentRepo = useStore(s => s.currentRepo);
  const setCurrentRepo = useStore(s => s.setCurrentRepo);
  const pageId = useStore(s => s.currentPageId);
  const openPage = useStore(s => s.openPage);
  const user = useStore(s => s.user);
  const peers = useStore(s => s.peers);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("gitwiki.sidebarWidth");
    return saved ? Math.max(180, Math.min(480, parseInt(saved, 10) || 256)) : 256;
  });
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.max(180, Math.min(480, e.clientX));
      setWidth(next);
    };
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false;
        localStorage.setItem("gitwiki.sidebarWidth", String(width));
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  return (
    <aside
      style={{ width }}
      className="flex flex-col shrink-0 bg-stone-100/70 text-stone-700 border-r border-stone-200/60 relative group/sidebar"
    >
      {/* Logo row */}
      <div className="h-12 flex items-center px-4 border-b border-stone-200/60">
        <div className="flex items-center gap-2 font-semibold text-stone-900 text-sm">
          <BookOpen className="size-4 text-emerald-400" />
          gitwiki
        </div>
        <div className="text-stone-700 mx-2">/</div>
        <select
          className="flex-1 text-sm bg-transparent text-stone-700 focus:outline-none cursor-pointer truncate hover:text-stone-900 transition"
          value={currentRepo ?? ""}
          onChange={(e) => setCurrentRepo(e.target.value)}
        >
          {repos.map(r => <option key={r.slug} value={r.slug} className="bg-white text-stone-900">{r.title}</option>)}
        </select>
      </div>

      {/* Pages label + new button */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="text-[10px] font-semibold text-stone-500 uppercase tracking-widest">页面</div>
        <NewPageButton parentId="" />
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto px-2 pb-4 space-y-px">
        {!tree ? (
          <div className="px-3 py-2 text-xs text-stone-500">加载…</div>
        ) : (
          <Tree node={tree} currentId={pageId} onOpen={(node) => {
            if (!currentRepo || !node.has_body) return;
            (async () => {
              const pc = await api.readPage(currentRepo, node.id);
              openPage(pc.id, pc.base_sha, pc.is_bundle);
            })();
          }} />
        )}
      </div>

      {/* Bottom: presence + user */}
      <div className="border-t border-stone-200/60 px-4 py-3 space-y-2">
        {peers.length > 1 && (
          <div className="flex items-center gap-2">
            <div className="flex -space-x-1">
              {peers.slice(0, 4).map(p => (
                <div
                  key={p.user}
                  title={p.name || p.user}
                  className="size-5 rounded-full text-white flex items-center justify-center text-[8px] font-semibold ring-2 ring-stone-100"
                  style={{ background: colorForUser(p.user) }}
                >
                  {(p.name || p.user).slice(0,1).toUpperCase()}
                </div>
              ))}
            </div>
            <span className="text-[11px] text-stone-500">{peers.length} 人正在编辑</span>
          </div>
        )}
        <div className="flex items-center gap-2 min-w-0">
          {user && <Avatar login={user.login} size={6} />}
          <span className="text-xs text-stone-500 truncate flex-1">@{user?.login}</span>
          <a href="/logout" title="登出" className="text-stone-400 hover:text-stone-700 transition">
            <LogOut className="size-3.5" />
          </a>
        </div>
      </div>
      {/* Drag handle — thin strip on the right edge */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-emerald-500/40 transition-colors"
        title="拖拽调整侧边栏宽度"
      />
    </aside>
  );
}

function Tree({ node, currentId, onOpen }: { node: PageMeta; currentId: string | null; onOpen: (n: PageMeta) => void }) {
  return (
    <TreeList siblings={node.children || []} parentId="" depth={0} currentId={currentId} onOpen={onOpen} />
  );
}

function TreeList({ siblings, parentId, depth, currentId, onOpen }: {
  siblings: PageMeta[];
  parentId: string;
  depth: number;
  currentId: string | null;
  onOpen: (n: PageMeta) => void;
}) {
  return (
    <>
      {siblings.map((c, i) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth}
          currentId={currentId}
          onOpen={onOpen}
          parentId={parentId}
          siblings={siblings}
          index={i}
        />
      ))}
    </>
  );
}

function TreeNode({ node, depth, currentId, onOpen, parentId, siblings, index }: {
  node: PageMeta;
  depth: number;
  currentId: string | null;
  onOpen: (n: PageMeta) => void;
  parentId: string;
  siblings: PageMeta[];
  index: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const currentRepo = useStore(s => s.currentRepo);
  const active = currentId === node.id;

  const move = async (dir: -1 | 1) => {
    if (!currentRepo) return;
    const j = index + dir;
    if (j < 0 || j >= siblings.length) return;
    const next = [...siblings];
    [next[index], next[j]] = [next[j], next[index]];
    try {
      await api.reorderPages(currentRepo, parentId, next.map(x => x.id));
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
    } catch (e: any) {
      toast.error(`排序失败: ${e.message}`);
    }
  };

  const onRename = async () => {
    if (!currentRepo || !renameValue.trim() || renameValue === node.title) { setRenaming(false); return; }
    try {
      await api.retitlePage(currentRepo, node.id, renameValue.trim());
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
      toast.success("已重命名");
    } catch (e: any) {
      toast.error(`重命名失败: ${e.message}`);
    }
    setRenaming(false);
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 2500);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const onDelete = async () => {
    if (!currentRepo) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await api.deletePage(currentRepo, node.id);
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
      if (useStore.getState().currentPageId === node.id) useStore.getState().closePage();
      toast.success("已删除");
    } catch (e: any) {
      toast.error(`删除失败: ${e.message}`);
      setConfirmDelete(false);
    }
  };

  return (
    <div>
      <div
        className={
          "group relative flex items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer select-none text-[13px] transition-colors " +
          (active
            ? "bg-white text-stone-900 font-medium shadow-sm ring-1 ring-stone-200/80"
            : "text-stone-600 hover:bg-stone-200/70 hover:text-stone-900")
        }
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => node.has_body ? onOpen(node) : setOpen(o => !o)}
        onDoubleClick={() => setRenaming(true)}
      >
        {node.is_dir && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            className="shrink-0 -ml-1 p-0.5 text-stone-400 hover:text-stone-700"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
        {!node.is_dir && <span className="w-4 shrink-0" />}
        {node.is_dir
          ? (open ? <FolderOpen className="size-3.5 text-amber-500/80 shrink-0" /> : <Folder className="size-3.5 text-amber-500/80 shrink-0" />)
          : <FileText className="size-3.5 text-stone-400 shrink-0" />}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-[13px] bg-white border border-emerald-500 rounded px-1.5 py-0.5 outline-none text-stone-900"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <span className="truncate flex-1" title={node.title}>{node.title}</span>
        )}
        <span className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Always-visible "+" per row: works on leaf too; backend promotes leaf to bundle automatically. */}
          <NewPageButton parentId={node.id} />
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
            <button title="上移" disabled={index === 0} className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800 disabled:opacity-20" onClick={() => move(-1)}>
              <ChevronUp className="size-3" />
            </button>
            <button title="下移" disabled={index === siblings.length - 1} className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800 disabled:opacity-20" onClick={() => move(1)}>
              <ChevronDownIcon className="size-3" />
            </button>
            <button title="重命名" className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800" onClick={() => setRenaming(true)}>
              <Pencil className="size-3" />
            </button>
            <button
              title={confirmDelete ? "再点一次确认删除" : "删除"}
              className={
                "p-1 rounded transition " +
                (confirmDelete
                  ? "bg-red-500 text-white"
                  : "hover:bg-red-50 text-red-500 hover:text-red-700")
              }
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        </span>
      </div>
      {open && node.is_dir && (
        <TreeList siblings={node.children || []} parentId={node.id} depth={depth + 1} currentId={currentId} onOpen={onOpen} />
      )}
    </div>
  );
}

function NewPageButton({ parentId }: { parentId: string }) {
  const currentRepo = useStore(s => s.currentRepo);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) setTitle("");
  }, [open]);

  const canCreate = !!title.trim();

  const doCreate = async () => {
    if (!currentRepo || !canCreate || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.createPage(currentRepo, { parent_id: parentId, title: title.trim() });
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
      setOpen(false);
      toast.success("已创建");
      // Auto-open the new page
      const pc = await api.readPage(currentRepo, res.id);
      useStore.getState().openPage(pc.id, pc.base_sha, pc.is_bundle);
    } catch (e: any) {
      toast.error(`创建失败: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="新建页面"
        className="p-1 rounded text-stone-500 hover:text-emerald-600 hover:bg-stone-200 transition"
      >
        <Plus className="size-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/40 z-20 flex items-start justify-center pt-32 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl w-96 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="font-semibold text-sm text-stone-900">新建页面</h3>
              {parentId && <p className="text-xs text-stone-500 mt-0.5">作为当前页面的子页面</p>}
            </div>
            <div className="px-5 py-3 border-t border-stone-100">
              <input
                className="w-full rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition"
                placeholder="页面标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doCreate(); }}
                autoFocus
              />
            </div>
            <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md text-sm text-stone-600 hover:bg-stone-100 transition">
                取消
              </button>
              <button
                id="np-create"
                className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                disabled={!canCreate || submitting}
                onClick={doCreate}
              >{submitting ? "创建中…" : "创建"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
