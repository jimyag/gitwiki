import { useState, useEffect } from "react";
import { useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { FileText, Folder, FolderOpen, Plus, ChevronRight, ChevronDown, ChevronUp, ChevronDown as ChevronDownIcon, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";

export function Sidebar() {
  const tree = useStore(s => s.tree);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const openPage = useStore(s => s.openPage);

  if (!tree) {
    return (
      <aside className="w-64 bg-neutral-100 flex flex-col shrink-0">
        <div className="px-4 py-3 text-xs text-neutral-400">加载页面…</div>
      </aside>
    );
  }

  return (
    <aside className="w-64 flex flex-col shrink-0 bg-neutral-100">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">页面</div>
        <NewPageButton parentId="" />
      </div>
      <div className="flex-1 overflow-auto px-2 pb-4 space-y-px">
        <Tree node={tree} currentId={pageId} onOpen={(node) => {
          if (!currentRepo || !node.has_body) return;
          (async () => {
            const pc = await api.readPage(currentRepo, node.id);
            openPage(pc.id, pc.base_sha, pc.is_bundle);
          })();
        }} />
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
          "group relative flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer select-none text-[13px] transition-colors " +
          (active
            ? "bg-white text-neutral-900 font-medium shadow-sm ring-1 ring-black/[0.04]"
            : "text-neutral-600 hover:bg-neutral-200/50")
        }
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => node.has_body ? onOpen(node) : setOpen(o => !o)}
        onDoubleClick={() => setRenaming(true)}
      >
        {node.is_dir && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            className="shrink-0 -ml-1 p-0.5 text-neutral-400 hover:text-neutral-600"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
        {!node.is_dir && <span className="w-4 shrink-0" />}
        {node.is_dir
          ? (open ? <FolderOpen className="size-3.5 text-amber-500 shrink-0" /> : <Folder className="size-3.5 text-amber-500 shrink-0" />)
          : <FileText className="size-3.5 text-neutral-400 shrink-0" />}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-[13px] bg-white border border-sky-300 rounded px-1 outline-none"
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
          <button title="上移" disabled={index === 0} className="p-1 rounded hover:bg-neutral-300/60 text-neutral-500 disabled:opacity-30" onClick={() => move(-1)}>
            <ChevronUp className="size-3" />
          </button>
          <button title="下移" disabled={index === siblings.length - 1} className="p-1 rounded hover:bg-neutral-300/60 text-neutral-500 disabled:opacity-30" onClick={() => move(1)}>
            <ChevronDownIcon className="size-3" />
          </button>
          <button title="重命名" className="p-1 rounded hover:bg-neutral-300/60 text-neutral-500" onClick={() => setRenaming(true)}>
            <Pencil className="size-3" />
          </button>
          {node.is_dir && <NewPageButton parentId={node.id} />}
          <button title="删除" className="p-1 rounded hover:bg-red-100 text-red-500" onClick={onDelete}>
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
        className="p-1 rounded hover:bg-neutral-200 text-neutral-500 hover:text-neutral-800"
      >
        <Plus className="size-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/30 z-20 flex items-start justify-center pt-32" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl w-96 shadow-2xl ring-1 ring-black/5 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-3 border-b border-neutral-100">
              <h3 className="font-semibold text-sm text-neutral-900">新建页面</h3>
              {parentId && <p className="text-xs text-neutral-400 mt-0.5">在 {parentId} 下</p>}
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs font-medium text-neutral-500 mb-1 block">标题</label>
                <input
                  className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-400 transition"
                  placeholder="通俗易懂的名字"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-500 mb-1 block">URL slug</label>
                <input
                  className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-mono outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-400 transition"
                  placeholder="getting-started"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && canCreate) document.getElementById("np-create")?.click(); }}
                />
              </div>
            </div>
            <div className="px-5 pb-5 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md text-sm text-neutral-600 hover:bg-neutral-100">
                取消
              </button>
              <button
                id="np-create"
                className="px-3 py-1.5 rounded-md bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
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
