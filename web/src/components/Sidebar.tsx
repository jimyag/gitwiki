import { useState, useEffect } from "react";
import { useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { FileText, Folder, FolderOpen, Plus, ChevronRight, ChevronDown, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";

export function Sidebar() {
  const tree = useStore(s => s.tree);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const openPage = useStore(s => s.openPage);

  if (!tree) {
    return <aside className="w-64 border-r border-neutral-200 bg-neutral-50/50 p-3 text-xs text-neutral-500">加载中…</aside>;
  }

  return (
    <aside className="w-64 border-r border-neutral-200 bg-neutral-50/50 flex flex-col shrink-0">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">页面</div>
        <NewPageButton parentId="" />
      </div>
      <div className="flex-1 overflow-auto px-1 pb-4">
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
  return <div>{(node.children || []).map(c => <TreeNode key={c.id} node={c} depth={0} currentId={currentId} onOpen={onOpen} />)}</div>;
}

function TreeNode({ node, depth, currentId, onOpen }: { node: PageMeta; depth: number; currentId: string | null; onOpen: (n: PageMeta) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const currentRepo = useStore(s => s.currentRepo);
  const active = currentId === node.id;

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
    if (!confirm(`删除页面 ${node.id}?`)) return;
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
          "group flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer select-none text-sm " +
          (active ? "bg-sky-100 text-sky-900 font-medium" : "hover:bg-neutral-200/60")
        }
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => node.has_body ? onOpen(node) : setOpen(o => !o)}
        onDoubleClick={() => setRenaming(true)}
      >
        {node.is_dir && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            className="p-0.5 hover:bg-neutral-300/60 rounded"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
        {!node.is_dir && <span className="w-4" />}
        {node.is_dir
          ? (open ? <FolderOpen className="size-3.5 text-amber-600 shrink-0" /> : <Folder className="size-3.5 text-amber-600 shrink-0" />)
          : <FileText className="size-3.5 text-neutral-400 shrink-0" />}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-sm bg-white border border-sky-300 rounded px-1 outline-none"
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
        <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button title="重命名" className="p-1 rounded hover:bg-neutral-300/60 text-neutral-500" onClick={() => setRenaming(true)}>
            <Pencil className="size-3" />
          </button>
          {node.is_dir && <NewPageButton parentId={node.id} />}
          <button title="删除" className="p-1 rounded hover:bg-red-100 text-red-500" onClick={onDelete}>
            <Trash2 className="size-3" />
          </button>
        </span>
      </div>
      {open && node.is_dir && (node.children || []).map(c => <TreeNode key={c.id} node={c} depth={depth + 1} currentId={currentId} onOpen={onOpen} />)}
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

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="新建页面"
        className="p-1 rounded hover:bg-neutral-300/60 text-neutral-500"
      >
        <Plus className="size-3" />
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/20 z-10 flex items-center justify-center" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg p-4 w-80 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-medium text-sm">新建页面{parentId ? `（在 ${parentId} 下）` : ""}</h3>
            <input className="w-full border border-neutral-200 rounded px-2 py-1 text-sm" placeholder="URL slug（如 getting-started）" value={slug} onChange={(e) => setSlug(e.target.value)} autoFocus />
            <input className="w-full border border-neutral-200 rounded px-2 py-1 text-sm" placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && slug && title) document.getElementById("np-create")?.click(); }} />
            <div className="flex justify-end gap-2 text-sm">
              <button onClick={() => setOpen(false)} className="px-3 py-1">取消</button>
              <button
                id="np-create"
                className="px-3 py-1 rounded bg-neutral-900 text-white disabled:opacity-50"
                disabled={!slug || !title}
                onClick={async () => {
                  if (!currentRepo) return;
                  try {
                    await api.createPage(currentRepo, { parent_id: parentId, slug, title });
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
