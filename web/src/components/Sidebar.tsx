import { useState, useEffect, useRef, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useCanWrite, useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { FileText, Folder, Plus, ChevronRight, BookOpen, LogOut, Search, Home, Tag } from "lucide-react";
import { toast } from "sonner";
import { HOME } from "../lib/route";
import { pagePath, parentOf } from "../lib/tree";
import { movePage } from "../lib/actions";
import { btnGhost, btnPrimary, overlay } from "./ui";

// Dragging a page onto another makes it a child of that page (onto the "页面" header: top
// level). The dragged id lives here because dataTransfer cannot be read during dragover.
let dragging: string | null = null;

function canDropInto(target: string): boolean {
  return dragging !== null && target !== dragging && !target.startsWith(dragging + "/") && target !== parentOf(dragging);
}

function dropHandlers(target: string, setOver: (o: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!canDropInto(target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const id = dragging;
      if (!id || !canDropInto(target)) return;
      dragging = null;
      const tree = useStore.getState().tree;
      const title = (pid: string) => pagePath(tree, pid).at(-1)?.title ?? pid;
      if (confirm(`把「${title(id)}」移动到${target ? `「${title(target)}」下面` : "顶层"}？其他页面里指向它的链接会自动更新。`)) {
        void movePage(id, target);
      }
    },
  };
}

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

// Width the user last dragged the sidebar to (also used by the boot frame in App).
export function savedSidebarWidth(): number {
  const saved = localStorage.getItem("gitwiki.sidebarWidth");
  return saved ? Math.max(180, Math.min(480, parseInt(saved, 10) || 256)) : 256;
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
  const navOpen = useStore(s => s.navOpen);
  const setNavOpen = useStore(s => s.setNavOpen);
  const setSearchOpen = useStore(s => s.setSearchOpen);
  const canWrite = useCanWrite();
  const [overTop, setOverTop] = useState(false);

  const [width, setWidth] = useState(savedSidebarWidth);
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
    <>
      {navOpen && <div className="fixed inset-0 z-30 bg-stone-900/25 md:hidden" onClick={() => setNavOpen(false)} />}
      {/* Below md the sidebar is an off-canvas drawer; from md up it is a resizable column. */}
      <aside
        style={{ "--sidebar-w": `${width}px` } as CSSProperties}
        className={
          "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transition-transform duration-200 " +
          // md:relative anchors the drag handle; without it the handle hangs off the viewport edge.
          "md:relative md:z-auto md:w-[var(--sidebar-w)] md:max-w-none md:translate-none md:transition-none " +
          (navOpen ? "translate-x-0 shadow-xl" : "-translate-x-full") +
          " flex flex-col shrink-0 bg-stone-50 text-stone-700 border-r border-stone-200"
        }
      >
        {/* Logo row */}
        <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-stone-200">
          <BookOpen className="size-4 shrink-0 text-emerald-600" />
          <span className="font-semibold text-stone-900 text-sm">gitwiki</span>
          <span className="text-stone-300">/</span>
          <select
            className="min-w-0 flex-1 text-sm bg-transparent text-stone-600 focus:outline-none cursor-pointer truncate hover:text-stone-900 transition"
            value={currentRepo ?? ""}
            onChange={(e) => setCurrentRepo(e.target.value)}
          >
            {repos.map(r => <option key={r.slug} value={r.slug} className="bg-white text-stone-900">{r.title}</option>)}
          </select>
        </div>

        <div className="mx-3 mt-3 flex items-center gap-1.5">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex-1 min-w-0 flex items-center gap-2 rounded-md border border-stone-200 bg-white px-2.5 h-8 text-[13px] text-stone-400 hover:border-stone-300 hover:text-stone-600 transition"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left">搜索页面</span>
            <kbd className="font-mono text-[10px] text-stone-400">⌘K</kbd>
          </button>
          <button
            onClick={() => useStore.getState().setTagsOpen("")}
            title="按标签浏览"
            className="size-8 shrink-0 flex items-center justify-center rounded-md border border-stone-200 bg-white text-stone-400 hover:border-stone-300 hover:text-stone-600 transition"
          >
            <Tag className="size-3.5" />
          </button>
        </div>

        <button
          onClick={() => openPage(HOME)}
          className={
            "mx-2 mt-3 flex items-center gap-2 rounded-md px-2 h-8 text-[13px] transition-colors " +
            (pageId === HOME
              ? "bg-white text-stone-900 font-medium shadow-sm ring-1 ring-stone-200/80"
              : "text-stone-600 hover:bg-stone-200/50 hover:text-stone-900")
          }
        >
          <Home className={"size-3.5 " + (pageId === HOME ? "text-stone-500" : "text-stone-400")} />首页
        </button>

        {/* Pages label + new button; also the drop target for moving a page to the top level */}
        <div
          {...dropHandlers("", setOverTop)}
          className={"mx-2 mt-2 pl-2 pr-0.5 py-1 flex items-center justify-between rounded-md " + (overTop ? "bg-emerald-50 ring-2 ring-emerald-500/50" : "")}
        >
          <div className="text-xs font-medium text-stone-400">{overTop ? "放到顶层" : "页面"}</div>
          {canWrite ? <NewPageButton parentId="" /> : <span className="h-6" />}
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-auto px-2 pb-4 space-y-px">
          {!tree ? (
            <div className="px-3 py-2 text-xs text-stone-400">加载中…</div>
          ) : (
            <Tree node={tree} currentId={pageId} onOpen={(node) => {
              if (node.has_body) openPage(node.id);
            }} />
          )}
        </div>

        {/* Bottom: presence + user */}
        <div className="border-t border-stone-200 px-4 py-3 space-y-2.5">
          {peers.length > 1 && (
            <div className="flex items-center gap-2">
              <div className="flex -space-x-1">
                {peers.slice(0, 4).map(p => (
                  <div
                    key={p.user}
                    title={p.name || p.user}
                    className="size-5 rounded-full text-white flex items-center justify-center text-[8px] font-semibold ring-2 ring-stone-50"
                    style={{ background: colorForUser(p.user) }}
                  >
                    {(p.name || p.user).slice(0,1).toUpperCase()}
                  </div>
                ))}
              </div>
              <span className="text-xs text-stone-500">{peers.length} 人在看这一页</span>
            </div>
          )}
          <div className="flex items-center gap-2 min-w-0">
            {user && <Avatar login={user.login} size={6} />}
            <span className="text-xs text-stone-500 truncate flex-1">{user?.login}</span>
            <a href="/logout" title="退出登录" className="p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition">
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
          className="hidden md:block absolute top-0 -right-0.5 w-1 h-full cursor-col-resize hover:bg-emerald-500/40 transition-colors"
          title="拖拽调整侧边栏宽度"
        />
      </aside>
    </>
  );
}

function Tree({ node, currentId, onOpen }: { node: PageMeta; currentId: string | null; onOpen: (n: PageMeta) => void }) {
  return (
    <TreeList siblings={node.children || []} depth={0} currentId={currentId} onOpen={onOpen} />
  );
}

function TreeList({ siblings, depth, currentId, onOpen }: {
  siblings: PageMeta[];
  depth: number;
  currentId: string | null;
  onOpen: (n: PageMeta) => void;
}) {
  return (
    <>
      {siblings.map((c) => (
        <TreeNode
          key={c.id}
          node={c}
          depth={depth}
          currentId={currentId}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

function TreeNode({ node, depth, currentId, onOpen }: {
  node: PageMeta;
  depth: number;
  currentId: string | null;
  onOpen: (n: PageMeta) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const [over, setOver] = useState(false);
  const currentRepo = useStore(s => s.currentRepo);
  const canWrite = useCanWrite();
  const active = currentId === node.id;
  const hasChildren = (node.children?.length ?? 0) > 0;

  const onRename = async () => {
    if (!currentRepo || !renameValue.trim() || renameValue === node.title) { setRenaming(false); return; }
    try {
      await api.retitlePage(currentRepo, node.id, renameValue.trim());
      await useStore.getState().refreshTree();
      toast.success("已重命名");
    } catch (e: any) {
      toast.error(`重命名失败：${e.message}`);
    }
    setRenaming(false);
  };

  // A page is a document even when it has children; only folders without a page file look like folders.
  const Icon = node.has_body ? FileText : Folder;

  return (
    <div>
      <div
        className={
          "group relative flex items-center gap-1.5 rounded-md pr-1 h-8 cursor-pointer select-none text-[13px] transition-colors " +
          (over
            ? "bg-emerald-50 text-stone-900 ring-2 ring-emerald-500/50"
            : active
            ? "bg-white text-stone-900 font-medium shadow-sm ring-1 ring-stone-200/80"
            : "text-stone-600 hover:bg-stone-200/50 hover:text-stone-900")
        }
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => node.has_body ? onOpen(node) : setOpen(o => !o)}
        onDoubleClick={() => canWrite && setRenaming(true)}
        draggable={canWrite && !renaming}
        onDragStart={(e) => {
          dragging = node.id;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.title);
        }}
        onDragEnd={() => { dragging = null; }}
        {...dropHandlers(node.id, setOver)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            title={open ? "折叠" : "展开"}
            className="shrink-0 size-5 -mr-0.5 flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200"
          >
            <ChevronRight className={"size-3.5 transition-transform " + (open ? "rotate-90" : "")} />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <Icon className={"size-3.5 shrink-0 " + (active ? "text-stone-500" : "text-stone-400")} />
        {renaming ? (
          <input
            autoFocus
            className="flex-1 min-w-0 text-[13px] bg-white border border-emerald-500 rounded px-1.5 py-0.5 outline-none text-stone-900"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void onRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <span className="truncate flex-1" title={node.title}>{node.title}</span>
        )}
        {node.draft && <span className="shrink-0 text-[10px] text-amber-600" title="草稿">草稿</span>}
        {/* "+" works on leaves too: the backend promotes a leaf to a bundle to host children. */}
        {canWrite && (
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
            <NewPageButton parentId={node.id} />
          </span>
        )}
      </div>
      {open && hasChildren && (
        <TreeList siblings={node.children || []} depth={depth + 1} currentId={currentId} onOpen={onOpen} />
      )}
    </div>
  );
}

function NewPageButton({ parentId }: { parentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={parentId ? "新建子页面" : "新建页面"}
        className="size-6 flex items-center justify-center rounded text-stone-400 hover:text-emerald-600 hover:bg-stone-200/80 transition"
      >
        <Plus className="size-3.5" />
      </button>
      {open && <NewPageDialog parentId={parentId} onClose={() => setOpen(false)} />}
    </>
  );
}

// Portaled to <body>: the sidebar drawer is transformed, which would otherwise trap position:fixed.
export function NewPageDialog({ parentId, onClose }: { parentId: string; onClose(): void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canCreate = !!title.trim();

  const doCreate = async () => {
    if (!currentRepo || !canCreate || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.createPage(currentRepo, { parent_id: parentId, title: title.trim() });
      await useStore.getState().refreshTree();
      onClose();
      toast.success("已创建");
      useStore.getState().openPage(res.id);
    } catch (e: any) {
      toast.error(`创建失败：${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className={`${overlay} flex items-start justify-center pt-[18vh] px-4`} onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="bg-white rounded-xl w-full max-w-sm shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3">
          <h3 className="font-semibold text-sm text-stone-900">{parentId ? "新建子页面" : "新建页面"}</h3>
          <p className="text-xs text-stone-500 mt-0.5">{parentId ? "放在当前页面下面" : "放在最顶层"}</p>
        </div>
        <div className="px-5 pb-4">
          <input
            className="w-full rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
            placeholder="页面标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreate();
              if (e.key === "Escape") onClose();
            }}
            autoFocus
          />
        </div>
        <div className="px-5 py-3 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
          <button onClick={onClose} className={btnGhost}>取消</button>
          <button className={btnPrimary} disabled={!canCreate || submitting} onClick={() => void doCreate()}>
            {submitting ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
