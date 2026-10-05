import { useState, useEffect, useRef, type CSSProperties, type DragEvent } from "react";
import { useCanWrite, useRepoInfo, useStore } from "../store";
import { api, loginUrl, type PageMeta } from "../lib/api";
import { Folder, Plus, ChevronRight, ChevronsUpDown, LogOut, Search, Home, Tag, FileUp, Trash2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { HOME } from "../lib/route";
import { pagePath, parentOf } from "../lib/tree";
import { movePage } from "../lib/actions";
import { Avatar, Dialog, btnGhost, btnPrimary, dialogFooter, input } from "./ui";
import { TrashDialog } from "./TrashDialog";

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

// Width the user last dragged the sidebar to (also used by the boot frame in App).
export function savedSidebarWidth(): number {
  const saved = localStorage.getItem("gitwiki.sidebarWidth");
  return saved ? Math.max(180, Math.min(480, parseInt(saved, 10) || 256)) : 256;
}

// Rows of the sidebar: the white raised row is the page that is open.
const rowIdle = "text-stone-600 hover:bg-stone-200/50 hover:text-stone-900";
const rowActive = "bg-white text-stone-900 font-medium shadow-sm ring-1 ring-stone-200/80";

export function Sidebar() {
  const tree = useStore(s => s.tree);
  const repos = useStore(s => s.repos);
  const repo = useRepoInfo();
  const pageId = useStore(s => s.currentPageId);
  const openPage = useStore(s => s.openPage);
  const user = useStore(s => s.user);
  const navOpen = useStore(s => s.navOpen);
  const setNavOpen = useStore(s => s.setNavOpen);
  const setSearchOpen = useStore(s => s.setSearchOpen);
  const canWrite = useCanWrite();
  const [overTop, setOverTop] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const [width, setWidth] = useState(savedSidebarWidth);
  const resizing = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const next = Math.max(180, Math.min(480, e.clientX));
      setWidth(next);
    };
    const onUp = () => {
      if (resizing.current) {
        resizing.current = false;
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

  const title = repo?.title ?? "gitwiki";
  const switchable = repos.length > 1;

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
        {/* The wiki. With several, the native select lies invisibly over the name and does the picking. */}
        <div className="h-12 shrink-0 flex items-center px-2 border-b border-stone-200">
          <div className={"relative flex-1 min-w-0 flex items-center gap-2 h-9 px-1.5 rounded-md transition-colors " + (switchable ? "hover:bg-stone-200/50" : "")}>
            <span className="size-6 shrink-0 rounded-md bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center">
              {[...title][0]?.toUpperCase()}
            </span>
            <span className="flex-1 min-w-0 truncate text-sm font-semibold text-stone-900">{title}</span>
            {switchable && (
              <>
                <ChevronsUpDown className="size-3.5 shrink-0 text-stone-400" />
                <select
                  aria-label="切换 Wiki"
                  value={repo?.slug ?? ""}
                  onChange={(e) => useStore.getState().goTo(e.target.value, HOME)}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                >
                  {repos.map(r => <option key={r.slug} value={r.slug}>{r.title}</option>)}
                </select>
              </>
            )}
          </div>
        </div>

        <nav className="shrink-0 px-2 pt-3 space-y-px">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full mb-2 flex items-center gap-2 h-8 px-2.5 rounded-md border border-stone-200 bg-white text-[13px] text-stone-400 hover:border-stone-300 hover:text-stone-600 transition"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left">搜索</span>
            <kbd className="font-sans text-[11px] text-stone-400">⌘K</kbd>
          </button>
          <NavItem icon={Home} label="首页" active={pageId === HOME} onClick={() => openPage(HOME)} />
          <NavItem icon={Tag} label="标签" onClick={() => useStore.getState().setTagsOpen("")} />
          {canWrite && <NavItem icon={Trash2} label="回收站" onClick={() => setTrashOpen(true)} />}
        </nav>

        {/* Pages label + new button; also the drop target for moving a page to the top level */}
        <div
          {...dropHandlers("", setOverTop)}
          className={"shrink-0 mx-2 mt-4 mb-1 h-7 pl-2 pr-0.5 flex items-center justify-between rounded-md " + (overTop ? "bg-emerald-50 ring-2 ring-emerald-500/50" : "")}
        >
          <div className="text-xs font-medium text-stone-400">{overTop ? "放到顶层" : "页面"}</div>
          {canWrite && (
            <div className="flex items-center gap-0.5">
              <ImportButton />
              <NewPageButton parentId="" />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {!tree ? (
            <div className="px-2 py-1.5 text-xs text-stone-400">加载中…</div>
          ) : (
            tree.children?.map(c => <TreeNode key={c.id} node={c} depth={0} currentId={pageId} />)
          )}
        </div>

        <div className="shrink-0 border-t border-stone-200 p-2">
          {user ? (
            <div className="flex items-center gap-2 h-9 pl-1.5 min-w-0">
              <Avatar login={user.login} name={user.name} />
              <span className="flex-1 min-w-0 truncate text-[13px] text-stone-700">{user.name || user.login}</span>
              <a href="/logout" title="退出登录" className="size-7 shrink-0 flex items-center justify-center rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition">
                <LogOut className="size-3.5" />
              </a>
            </div>
          ) : (
            <a href={loginUrl()} className={`${btnPrimary} w-full justify-center`}>登录后可编辑</a>
          )}
        </div>
        {/* Drag handle — thin strip on the right edge */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            resizing.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          className="hidden md:block absolute top-0 -right-0.5 w-1 h-full cursor-col-resize hover:bg-emerald-500/40 transition-colors"
          title="拖拽调整侧边栏宽度"
        />
      </aside>
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} />}
    </>
  );
}

function NavItem({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick(): void }) {
  return (
    <button
      onClick={onClick}
      className={"w-full flex items-center gap-2 h-8 md:h-7 px-2 rounded-md text-[13px] transition-colors " + (active ? rowActive : rowIdle)}
    >
      <Icon className={"size-3.5 shrink-0 " + (active ? "text-emerald-600" : "text-stone-400")} />{label}
    </button>
  );
}

function TreeNode({ node, depth, currentId }: { node: PageMeta; depth: number; currentId: string | null }) {
  const below = !!currentId?.startsWith(node.id + "/"); // the open page is somewhere under this one
  const [open, setOpen] = useState(depth < 2 || below);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const [over, setOver] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const currentRepo = useStore(s => s.currentRepo);
  const canWrite = useCanWrite();
  const active = currentId === node.id;
  const hasChildren = (node.children?.length ?? 0) > 0;

  // Opening a deep page (from search or a link) unfolds the way to it and brings it into view.
  useEffect(() => { if (below) setOpen(true); }, [below]);
  useEffect(() => { if (active) row.current?.scrollIntoView({ block: "nearest" }); }, [active]);

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

  return (
    <div>
      <div
        ref={row}
        className={
          "group flex items-center gap-1 h-8 md:h-7 pl-1 pr-1 rounded-md cursor-pointer select-none text-[13px] transition-colors " +
          (over ? "bg-emerald-50 text-stone-900 ring-2 ring-emerald-500/50" : active ? rowActive : rowIdle)
        }
        onClick={() => node.has_body ? useStore.getState().openPage(node.id) : setOpen(o => !o)}
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
            className="shrink-0 size-5 flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/80"
          >
            <ChevronRight className={"size-3.5 transition-transform " + (open ? "rotate-90" : "")} />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {/* Every row is a page; only folders without a page file get an icon, since opening them does nothing. */}
        {!node.has_body && <Folder className="size-3.5 shrink-0 text-stone-400" />}
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
          <span className="truncate flex-1 pl-0.5" title={node.title}>{node.title}</span>
        )}
        {node.draft && <span className="shrink-0 text-[10px] text-amber-600" title="草稿">草稿</span>}
        {/* "+" works on leaves too: the backend promotes a leaf to a bundle to host children. */}
        {canWrite && (
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
            <NewPageButton parentId={node.id} />
          </span>
        )}
      </div>
      {/* The left border is the indent guide; it lines up under the chevron above. */}
      {open && hasChildren && (
        <div className="ml-[13px] pl-1.5 border-l border-stone-200">
          {node.children!.map(c => <TreeNode key={c.id} node={c} depth={depth + 1} currentId={currentId} />)}
        </div>
      )}
    </div>
  );
}

const smallBtn = "size-6 flex items-center justify-center rounded text-stone-400 hover:text-emerald-600 hover:bg-stone-200/80 transition";

function NewPageButton({ parentId }: { parentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={parentId ? "新建子页面" : "新建页面"} className={smallBtn}>
        <Plus className="size-3.5" />
      </button>
      {open && <NewPageDialog parentId={parentId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportButton() {
  const repo = useStore(s => s.repos.find(r => r.slug === s.currentRepo));
  const [open, setOpen] = useState(false);
  if (!repo?.source?.length) return null; // 仓库没有配置任何 import source 就不出现入口
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="从 Markdown / MediaWiki 导入页面" className={smallBtn}>
        <FileUp className="size-3.5" />
      </button>
      {open && <ImportDialog source={repo.source} onClose={() => setOpen(false)} />}
    </>
  );
}

export function NewPageDialog({ parentId, onClose }: { parentId: string; onClose(): void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const parentTitle = useStore(s => pagePath(s.tree, parentId).at(-1)?.title);
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

  return (
    <Dialog onClose={onClose}>
      <div className="px-5 pt-5 pb-4">
        <h3 className="text-sm font-semibold text-stone-900">{parentId ? "新建子页面" : "新建页面"}</h3>
        <p className="mt-0.5 text-xs text-stone-500 truncate">{parentId ? `放在「${parentTitle ?? parentId}」下面` : "放在最顶层"}</p>
        <input
          autoFocus
          className={`${input} mt-4`}
          placeholder="页面标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); }}
        />
      </div>
      <div className={dialogFooter}>
        <button onClick={onClose} className={btnGhost}>取消</button>
        <button className={btnPrimary} disabled={!canCreate || submitting} onClick={() => void doCreate()}>
          {submitting ? "创建中…" : "创建"}
        </button>
      </div>
    </Dialog>
  );
}

function ImportDialog({ source, onClose }: { source: string[]; onClose(): void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const [title, setTitle] = useState("");
  const [type, setType] = useState(source[0]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    if (!currentRepo || !title.trim() || !file || busy) return;
    setBusy(true);
    try {
      const res = await api.importPage(currentRepo, { title: title.trim(), type, file });
      await useStore.getState().refreshTree();
      onClose();
      toast.success("已导入");
      useStore.getState().openPage(res.id);
    } catch (e) {
      toast.error(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose}>
      <div className="px-5 pt-5 pb-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">导入页面</h3>
          <p className="mt-0.5 text-xs text-stone-500">把旧文档文件转成 Markdown 放进来</p>
        </div>
        <input autoFocus className={input} placeholder="页面标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value)} className={input}>
          {source.map(t => <option key={t} value={t}>{t === "markdown" ? "Markdown (原样)" : "MediaWiki"}</option>)}
        </select>
        <input
          type="file"
          accept={type === "markdown" ? ".md,.markdown,.txt" : ".txt,.wiki,.mediawiki,.md"}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm text-stone-600 file:mr-3 file:rounded-md file:border file:border-stone-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:text-stone-700 hover:file:bg-stone-50"
        />
      </div>
      <div className={dialogFooter}>
        <button onClick={onClose} className={btnGhost}>取消</button>
        <button className={btnPrimary} disabled={!title.trim() || !file || busy} onClick={() => void doImport()}>
          {busy ? "导入中…" : "导入"}
        </button>
      </div>
    </Dialog>
  );
}
