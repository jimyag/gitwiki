import { useState, useEffect } from "react";
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

  return (
    <aside className="w-64 flex flex-col shrink-0 bg-stone-950 text-stone-300">
      {/* Logo row */}
      <div className="h-12 flex items-center px-4 border-b border-stone-800/60">
        <div className="flex items-center gap-2 font-semibold text-white text-sm">
          <BookOpen className="size-4 text-emerald-400" />
          gitwiki
        </div>
        <div className="text-stone-700 mx-2">/</div>
        <select
          className="flex-1 text-sm bg-transparent text-stone-300 focus:outline-none cursor-pointer truncate hover:text-white transition"
          value={currentRepo ?? ""}
          onChange={(e) => setCurrentRepo(e.target.value)}
        >
          {repos.map(r => <option key={r.slug} value={r.slug} className="bg-stone-900">{r.title}</option>)}
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
      <div className="border-t border-stone-800/60 px-4 py-3 space-y-2">
        {peers.length > 1 && (
          <div className="flex items-center gap-2">
            <div className="flex -space-x-1">
              {peers.slice(0, 4).map(p => (
                <div
                  key={p.user}
                  title={p.name || p.user}
                  className="size-5 rounded-full text-white flex items-center justify-center text-[8px] font-semibold ring-2 ring-stone-950"
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
          <span className="text-xs text-stone-400 truncate flex-1">@{user?.login}</span>
          <a href="/logout" title="登出" className="text-stone-500 hover:text-stone-200 transition">
            <LogOut className="size-3.5" />
          </a>
        </div>
      </div>
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
    if (!currentRepo || renameValue === node.title) { setRenaming(false); return; }
    const parent = node.id.includes("/") ? node.id.slice(0, node.id.lastIndexOf("/")) : "";
    const newId = parent ? `${parent}/${renameValue}` : renameValue;
    try {
      await api.renamePage(currentRepo, node.id, newId);
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
      toast.success("已重命名");
    } catch (e: any) {
      toast.error(`重命名失败: ${e.message}`);
    }
    setRenaming(false);
  };

  const onDelete = async () => {
    if (!currentRepo) return;
    if (!confirm(`删除页面 "${node.title}"?`)) return;
    try {
      await api.deletePage(currentRepo, node.id);
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
      if (useStore.getState().currentPageId === node.id) useStore.getState().closePage();
      toast.success("已删除");
    } catch (e: any) {
      toast.error(`删除失败: ${e.message}`);
    }
  };

  return (
    <div>
      <div
        className={
          "group relative flex items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer select-none text-[13px] transition-colors " +
          (active
            ? "bg-stone-800 text-white font-medium"
            : "text-stone-400 hover:bg-stone-900 hover:text-stone-200")
        }
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => node.has_body ? onOpen(node) : setOpen(o => !o)}
        onDoubleClick={() => setRenaming(true)}
      >
        {node.is_dir && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            className="shrink-0 -ml-1 p-0.5 text-stone-600 hover:text-stone-300"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
        {!node.is_dir && <span className="w-4 shrink-0" />}
        {node.is_dir
          ? (open ? <FolderOpen className="size-3.5 text-amber-500/80 shrink-0" /> : <Folder className="size-3.5 text-amber-500/80 shrink-0" />)
          : <FileText className="size-3.5 text-stone-600 shrink-0" />}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-[13px] bg-stone-800 border border-emerald-500 rounded px-1.5 py-0.5 outline-none text-white"
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
          <span className="truncate flex-1">{node.title}</span>
        )}
        <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button title="上移" disabled={index === 0} className="p-1 rounded hover:bg-stone-700 text-stone-500 hover:text-stone-200 disabled:opacity-20" onClick={() => move(-1)}>
            <ChevronUp className="size-3" />
          </button>
          <button title="下移" disabled={index === siblings.length - 1} className="p-1 rounded hover:bg-stone-700 text-stone-500 hover:text-stone-200 disabled:opacity-20" onClick={() => move(1)}>
            <ChevronDownIcon className="size-3" />
          </button>
          <button title="重命名" className="p-1 rounded hover:bg-stone-700 text-stone-500 hover:text-stone-200" onClick={() => setRenaming(true)}>
            <Pencil className="size-3" />
          </button>
          {node.is_dir && <NewPageButton parentId={node.id} />}
          <button title="删除" className="p-1 rounded hover:bg-red-900/50 text-red-400 hover:text-red-300" onClick={onDelete}>
            <Trash2 className="size-3" />
          </button>
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
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) { setSlug(""); setTitle(""); }
  }, [open]);

  const canCreate = slug.trim() && title.trim();

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="新建页面"
        className="p-1 rounded text-stone-500 hover:text-emerald-400 hover:bg-stone-800 transition"
      >
        <Plus className="size-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/50 z-20 flex items-start justify-center pt-32 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl w-96 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3">
              <h3 className="font-semibold text-sm text-stone-900">新建页面</h3>
              {parentId && <p className="text-xs text-stone-500 mt-0.5">位于 <code className="font-mono text-[11px] bg-stone-100 px-1 rounded">{parentId}</code> 下</p>}
            </div>
            <div className="px-5 py-3 space-y-3 border-t border-stone-100">
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">标题</label>
                <input
                  className="w-full rounded-md border border-stone-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition"
                  placeholder="通俗易懂的名字"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-stone-600 mb-1 block">URL slug</label>
                <input
                  className="w-full rounded-md border border-stone-200 px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 transition"
                  placeholder="getting-started"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && canCreate) document.getElementById("np-create")?.click(); }}
                />
              </div>
            </div>
            <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md text-sm text-stone-600 hover:bg-stone-100 transition">
                取消
              </button>
              <button
                id="np-create"
                className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                disabled={!canCreate}
                onClick={async () => {
                  if (!currentRepo) return;
                  try {
                    await api.createPage(currentRepo, { parent_id: parentId, slug: slug.trim(), title: title.trim() });
                    const tree = await api.pageTree(currentRepo);
                    useStore.getState().setTree(tree);
                    setOpen(false);
                    toast.success("已创建");
                  } catch (e: any) {
                    toast.error(`创建失败: ${e.message}`);
                  }
                }}
              >创建</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
