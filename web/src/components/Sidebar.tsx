import { useState, useEffect, useRef, type CSSProperties, type DragEvent } from "react";
import { useCanWrite, useRepoInfo, useStore } from "../store";
import { api, loginUrl, type PageMeta, type PageTemplate, type SyncStatus, type User } from "../lib/api";
import {
  Folder, Plus, ChevronRight, ChevronsUpDown, LogOut, Search, Home, Tag, FileUp, Trash2, Cloud, CloudOff,
  RefreshCw, Sun, Moon, Monitor, Star, Keyboard, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { HOME } from "../lib/route";
import { pagePath, parentOf } from "../lib/tree";
import { movePage, placePage } from "../lib/actions";
import { useFavorites } from "../lib/recents";
import { setThemePref, useThemePref } from "../lib/theme";
import { Avatar, Dialog, Kbd, Menu, btnGhost, btnPrimary, dialogDesc, dialogFooter, dialogTitle, iconBtn, input, isMac, select } from "./ui";
import { TrashDialog } from "./TrashDialog";

// Dragging a page onto the middle of another makes it a child of that page (onto the "页面"
// header: top level); onto the top or bottom edge of a row puts it before or after that page.
// The dragged id lives here because dataTransfer cannot be read during dragover.
let dragging: string | null = null;

type Drop = "before" | "inside" | "after";

// Where dropping on target would put the dragged page; null where it cannot go.
function dropAt(e: DragEvent, target: string, edges: boolean): Drop | null {
  if (dragging === null || target === dragging || target.startsWith(dragging + "/")) return null;
  const box = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - box.top) / box.height;
  if (edges && y < 0.25) return "before";
  if (edges && y > 0.75) return "after";
  return target === parentOf(dragging) ? null : "inside"; // already there
}

function moveQuestion(id: string, parent: string): string {
  const tree = useStore.getState().tree;
  const title = (pid: string) => pagePath(tree, pid).at(-1)?.title ?? pid;
  return `把「${title(id)}」移动到${parent ? `「${title(parent)}」下面` : "顶层"}？其他页面里指向它的链接会自动更新。`;
}

// edges: a page row, which also takes drops beside it; the header only takes them inside.
function dropHandlers(target: string, setOver: (o: Drop | null) => void, edges = true) {
  return {
    onDragOver: (e: DragEvent) => {
      const at = dropAt(e, target, edges);
      setOver(at);
      if (!at) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const at = dropAt(e, target, edges);
      setOver(null);
      const id = dragging;
      if (!id || !at) return;
      dragging = null;
      const parent = at === "inside" ? target : parentOf(target);
      // Reordering among siblings needs no question; changing parent rewrites links.
      if (parentOf(id) !== parent && !confirm(moveQuestion(id, parent))) return;
      if (at === "inside") void movePage(id, target);
      else void placePage(id, target, at === "after");
    },
  };
}

// The drop marker on a row: a line above or below it, or the row lit up for "inside".
const dropMark: Record<Drop, string> = {
  before: "relative before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-accent ",
  after: "relative after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent ",
  inside: "bg-accent-soft text-fg ring-2 ring-accent/50 ",
};

// Width the user last dragged the sidebar to (also used by the boot frame in App).
export function savedSidebarWidth(): number {
  const saved = localStorage.getItem("gitwiki.sidebarWidth");
  return saved ? Math.max(180, Math.min(480, parseInt(saved, 10) || 256)) : 256;
}

// Rows of the sidebar. It sits on the canvas; the open page is raised like the content panel.
const row = "w-full flex items-center gap-2 h-[34px] md:h-[30px] rounded-lg text-sm select-none transition-colors ";
const rowIdle = "text-fg-2 hover:bg-shade hover:text-fg";
const rowActive = "bg-surface text-fg font-medium shadow-xs ring-1 ring-line";

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
  const [overTop, setOverTop] = useState<Drop | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const [width, setWidth] = useState(savedSidebarWidth);
  const resizing = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      setWidth(Math.max(180, Math.min(480, e.clientX)));
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

  const title = useStore(s => s.settings?.title) ?? repo?.title ?? "gitwiki";
  const switchable = repos.length > 1;

  return (
    <>
      {navOpen && <div className="fixed inset-0 z-30 bg-stone-950/30 animate-fade-in md:hidden" onClick={() => setNavOpen(false)} />}
      {/* Below md the sidebar is an off-canvas drawer; from md up it is a resizable column. */}
      <aside
        style={{ "--sidebar-w": `${width}px` } as CSSProperties}
        className={
          "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transition-transform duration-200 ease-out " +
          // md:relative anchors the drag handle; without it the handle hangs off the viewport edge.
          "md:relative md:z-auto md:w-[var(--sidebar-w)] md:max-w-none md:translate-none md:transition-none " +
          (navOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full") +
          " flex flex-col shrink-0 bg-canvas text-fg-2"
        }
      >
        {/* The wiki, lined up with the panel's top bar. With several wikis, the native select lies
            invisibly over the name and does the picking. */}
        <div className="h-12 shrink-0 flex items-center gap-1 px-2 md:mt-2">
          <div className={"relative flex-1 min-w-0 flex items-center gap-2.5 h-9 px-2 rounded-lg transition-colors " + (switchable ? "hover:bg-shade" : "")}>
            <span className="size-6 shrink-0 rounded-md bg-emerald-600 text-white text-xs font-semibold flex items-center justify-center shadow-xs">
              {[...title][0]?.toUpperCase()}
            </span>
            <span className="flex-1 min-w-0 truncate text-sm font-semibold text-fg">{title}</span>
            {switchable && (
              <>
                <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
                <select
                  aria-label="切换 Wiki"
                  value={repo?.slug ?? ""}
                  onChange={(e) => useStore.getState().goTo(e.target.value, HOME)}
                  className="absolute inset-0 w-full opacity-0 cursor-pointer"
                >
                  {repos.map(r => <option key={r.slug} value={r.slug}>{r.slug}</option>)}
                </select>
              </>
            )}
          </div>
          {canWrite && <SyncButton />}
        </div>

        <div className="shrink-0 px-2 pt-1">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg bg-surface text-[13px] text-fg-subtle shadow-xs ring-1 ring-line transition-colors hover:text-fg-muted"
          >
            <Search className="size-3.5" />
            <span className="flex-1 text-left">搜索</span>
            <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
          </button>
        </div>

        <nav className="shrink-0 px-2 pt-3 space-y-px">
          <NavItem icon={Home} label="首页" active={pageId === HOME} onClick={() => openPage(HOME)} />
          <NavItem icon={Tag} label="标签" onClick={() => useStore.getState().setTagsOpen("")} />
          {canWrite && <NavItem icon={Trash2} label="回收站" onClick={() => setTrashOpen(true)} />}
        </nav>

        <Favorites currentId={pageId} />

        {/* Pages label + new button; also the drop target for moving a page to the top level */}
        <div
          {...dropHandlers("", setOverTop, false)}
          className={"shrink-0 mx-2 mt-5 mb-1 h-7 pl-2 pr-0.5 flex items-center justify-between rounded-lg " + (overTop ? "bg-accent-soft ring-2 ring-accent/50" : "")}
        >
          <div className="text-xs font-medium text-fg-subtle">{overTop ? "放到顶层" : "页面"}</div>
          {canWrite && (
            <div className="flex items-center gap-0.5">
              <ImportButton />
              <NewPageButton parentId="" />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {!tree ? (
            <div className="space-y-2 px-2 py-2 animate-pulse" aria-label="加载中">
              {[70, 55, 62, 45].map(w => <div key={w} className="h-3 rounded bg-shade" style={{ width: `${w}%` }} />)}
            </div>
          ) : (
            tree.children?.map(c => <TreeNode key={c.id} node={c} depth={0} currentId={pageId} />)
          )}
        </div>

        <div className="shrink-0 p-2">
          {user ? <UserMenu user={user} /> : (
            <a href={loginUrl()} className={`${btnPrimary} w-full`}>登录后可编辑</a>
          )}
        </div>
        {/* Drag handle on the right edge; shows a line while hovered */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            resizing.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          className="group/resize hidden md:flex absolute top-0 -right-1.5 w-3 h-full justify-center cursor-col-resize"
          title="拖拽调整侧边栏宽度"
        >
          <span className="w-0.5 h-full bg-transparent transition-colors group-hover/resize:bg-accent/40" />
        </div>
      </aside>
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} />}
    </>
  );
}

function NavItem({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick(): void }) {
  return (
    <button onClick={onClick} className={row + "px-2 " + (active ? rowActive : rowIdle)}>
      <Icon className={"size-4 shrink-0 " + (active ? "text-accent-strong" : "text-fg-subtle")} />{label}
    </button>
  );
}

// This browser's favorites, under their current titles (a favorite keeps the title it had when
// starred). Pages that are gone drop out until they are restored. They stay in view above the
// page tree, which scrolls on its own; a long list scrolls within its own share of the height.
function Favorites({ currentId }: { currentId: string | null }) {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree);
  const favs = useFavorites(repo);
  const pages = favs.flatMap(f => {
    const path = pagePath(tree, f.page);
    const node = path.at(-1);
    return node?.has_body ? [{ id: node.id, title: node.title, where: path.slice(0, -1).map(n => n.title).join(" / ") }] : [];
  });
  if (!pages.length) return null;
  return (
    <section className="shrink-0 flex flex-col max-h-[30%] px-2 mt-5">
      <div className="shrink-0 h-7 mb-1 pl-2 flex items-center text-xs font-medium text-fg-subtle">收藏</div>
      <div className="overflow-y-auto">
      {pages.map(p => (
        <button
          key={p.id}
          onClick={() => useStore.getState().openPage(p.id)}
          title={p.where ? `${p.where} / ${p.title}` : p.title}
          className={row + "gap-1 pl-1 pr-2 " + (currentId === p.id ? rowActive : rowIdle)}
        >
          <span className="w-5 shrink-0 flex justify-center"><Star className="size-3.5 text-fg-subtle" /></span>
          <span className="truncate flex-1 pl-0.5 text-left">{p.title}</span>
        </button>
      ))}
      </div>
    </section>
  );
}

function UserMenu({ user }: { user: User }) {
  const pref = useThemePref();
  return (
    <Menu
      up
      align="start"
      label="账号与外观"
      buttonClass="w-full flex items-center gap-2.5 h-10 px-2 rounded-lg text-left text-sm text-fg-2 transition-colors hover:bg-shade"
      entries={[
        { label: "浅色", icon: <Sun />, checked: pref === "light", onClick: () => setThemePref("light") },
        { label: "深色", icon: <Moon />, checked: pref === "dark", onClick: () => setThemePref("dark") },
        { label: "跟随系统", icon: <Monitor />, checked: pref === "system", onClick: () => setThemePref("system") },
        "-",
        { label: "键盘快捷键", icon: <Keyboard />, onClick: () => useStore.getState().setShortcutsOpen(true) },
        { label: "退出登录", icon: <LogOut />, onClick: () => { location.href = "/logout"; } },
      ]}
    >
      <Avatar login={user.login} name={user.name} />
      <span className="flex-1 min-w-0 truncate">{user.name || user.login}</span>
      <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
    </Menu>
  );
}

// The status's failure, as the server's "sync" messages report it.
const syncFailure = (s: SyncStatus) => s.push_error || s.pull_error || null;

// The repo's sync with GitHub: quiet while it works, red while pushing or pulling fails.
function SyncButton() {
  const slug = useStore(s => s.currentRepo);
  const syncError = useStore(s => s.syncError);
  const [open, setOpen] = useState(false);
  // Messages only come with the next attempt: a failure from before this page loaded shows now.
  useEffect(() => {
    if (!slug) return;
    let live = true;
    api.syncStatus(slug).then(s => { if (live) useStore.getState().setSyncError(syncFailure(s)); }, () => {});
    return () => { live = false; };
  }, [slug]);
  return (
    <>
      <button onClick={() => setOpen(true)} title={syncError ? "同步失败，点击查看" : "同步状态"} className={`${iconBtn} relative`}>
        {syncError ? <CloudOff className="size-4 text-red-600 dark:text-red-400" /> : <Cloud className="size-4" />}
        {syncError && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-red-500" />}
      </button>
      {open && slug && <SyncDialog key={slug} slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}

export function SyncDialog({ slug, onClose }: { slug: string; onClose(): void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.syncStatus(slug);
        if (!cancelled) {
          setStatus(next);
          setError(null);
          useStore.getState().setSyncError(syncFailure(next));
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [slug]);

  async function sync() {
    setRequesting(true);
    try {
      setStatus(await api.syncNow(slug));
      setError(null);
      toast.success("已触发同步");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRequesting(false);
    }
  }
  const busy = requesting || status?.running || status?.queued;
  const failed = !!(status?.pull_error || status?.push_error);
  return (
    <Dialog onClose={onClose}>
      <div className="px-5 pt-5 pb-4">
        <h2 className={dialogTitle}>同步状态</h2>
        <p className={dialogDesc}>每分钟检查 GitHub 上的更改，已保存的修改会自动推送。</p>
        {status ? (
          <dl className="mt-4 divide-y divide-line rounded-xl text-sm ring-1 ring-line" aria-live="polite">
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-fg-muted">最近成功拉取</dt><dd className="text-fg">{status.last_pull ? new Date(status.last_pull).toLocaleString() : "尚未成功拉取"}</dd></div>
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-fg-muted">待推送提交</dt><dd className="text-fg">{status.pending} 个</dd></div>
            <div className="flex justify-between gap-3 px-3.5 py-2.5">
              <dt className="text-fg-muted">当前状态</dt>
              <dd className="inline-flex items-center gap-1.5 text-fg">
                <span className={"size-1.5 rounded-full " + (busy ? "bg-amber-500 animate-pulse" : failed ? "bg-red-500" : "bg-emerald-500")} />
                {busy ? "同步中…" : failed ? "同步失败，会自动重试" : "空闲"}
              </dd>
            </div>
          </dl>
        ) : !error && <p className="mt-4 text-sm text-fg-muted">加载中…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {status?.pull_error && <p role="alert" className="mt-3 text-sm text-red-600 whitespace-pre-wrap break-all dark:text-red-400">拉取失败：{status.pull_error}</p>}
        {status?.push_error && <p role="alert" className="mt-3 text-sm text-red-600 whitespace-pre-wrap break-all dark:text-red-400">推送失败：{status.push_error}</p>}
      </div>
      <div className={dialogFooter}>
        <button onClick={onClose} className={btnGhost}>关闭</button>
        <button onClick={() => void sync()} disabled={!status || !!busy} className={btnPrimary}>
          <RefreshCw className={`size-3.5${busy ? " animate-spin" : ""}`} />{busy ? "同步中…" : "立即同步"}
        </button>
      </div>
    </Dialog>
  );
}

function TreeNode({ node, depth, currentId }: { node: PageMeta; depth: number; currentId: string | null }) {
  const below = !!currentId?.startsWith(node.id + "/"); // the open page is somewhere under this one
  const [open, setOpen] = useState(depth < 2 || below);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.title);
  const [over, setOver] = useState<Drop | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const currentRepo = useStore(s => s.currentRepo);
  const canWrite = useCanWrite();
  const active = currentId === node.id;
  const hasChildren = (node.children?.length ?? 0) > 0;

  // Opening a deep page (from search or a link) unfolds the way to it and brings it into view.
  useEffect(() => { if (below) setOpen(true); }, [below]);
  useEffect(() => { if (active) rowRef.current?.scrollIntoView({ block: "nearest" }); }, [active]);

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
        ref={rowRef}
        className={
          "group " + row + "gap-1 pl-1 pr-1 cursor-pointer " +
          (over ? dropMark[over] : "") + (over === "inside" ? "" : active ? rowActive : rowIdle)
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
            className="shrink-0 size-5 flex items-center justify-center rounded-md text-fg-subtle hover:text-fg hover:bg-shade"
          >
            <ChevronRight className={"size-3.5 transition-transform duration-150 " + (open ? "rotate-90" : "")} />
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        {/* Every row is a page; only folders without a page file get an icon, since opening them does nothing. */}
        {!node.has_body && <Folder className="size-3.5 shrink-0 text-fg-subtle" />}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 min-w-0 h-6 rounded-md bg-surface px-1.5 text-sm text-fg outline-none ring-2 ring-accent/60"
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
        {node.draft && <span className="shrink-0 rounded px-1 text-[10px] font-medium text-amber-700 bg-amber-500/10 dark:text-amber-300" title="草稿">草稿</span>}
        {/* "+" works on leaves too: the backend promotes a leaf to a bundle to host children. */}
        {canWrite && (
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0" onClick={(e) => e.stopPropagation()}>
            <NewPageButton parentId={node.id} />
          </span>
        )}
      </div>
      {/* The left border is the indent guide; it lines up under the chevron above. */}
      {open && hasChildren && (
        <div className="ml-[13px] pl-1.5 border-l border-line">
          {node.children!.map(c => <TreeNode key={c.id} node={c} depth={depth + 1} currentId={currentId} />)}
        </div>
      )}
    </div>
  );
}

const smallBtn = "size-6 flex items-center justify-center rounded-md text-fg-subtle transition-colors hover:text-fg hover:bg-shade";

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
  const source = useStore(s => s.settings?.source);
  const [open, setOpen] = useState(false);
  if (!source?.length) return null; // 仓库设置里没有配置 source 就不出现入口
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="从 Markdown / MediaWiki 导入页面" className={smallBtn}>
        <FileUp className="size-3.5" />
      </button>
      {open && <ImportDialog source={source} onClose={() => setOpen(false)} />}
    </>
  );
}

export function NewPageDialog({ parentId, onClose }: { parentId: string; onClose(): void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const parentTitle = useStore(s => pagePath(s.tree, parentId).at(-1)?.title);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<PageTemplate[]>([]);
  const [template, setTemplate] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [templatesLoading, setTemplatesLoading] = useState(true);
  useEffect(() => {
    if (!currentRepo) return;
    let live = true;
    api.templates(currentRepo).then(t => { if (live) setTemplates(t); }, e => { if (live) setTemplateError(e.message); })
      .finally(() => { if (live) setTemplatesLoading(false); });
    return () => { live = false; };
  }, [currentRepo]);
  const canCreate = !!title.trim();
  const picked = templates.find(t => t.id === template);

  const doCreate = async () => {
    if (!currentRepo || !canCreate || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.createPage(currentRepo, { parent_id: parentId, title: title.trim(), template });
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
    <Dialog onClose={onClose} className="max-w-md">
      <div className="px-5 pt-5 pb-4">
        <h2 className={dialogTitle}>{parentId ? "新建子页面" : "新建页面"}</h2>
        <p className={`${dialogDesc} truncate`}>{parentId ? `放在「${parentTitle ?? parentId}」下面` : "放在最顶层"}</p>
        <input
          autoFocus
          className={`${input} mt-4`}
          placeholder="页面标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); }}
        />
        <label className="mt-4 block text-xs font-medium text-fg-muted">模板
          <select aria-label="模板" value={template} onChange={e => setTemplate(e.target.value)} className={`${select} mt-1.5`} disabled={templatesLoading}>
            <option value="">{templatesLoading ? "正在加载模板…" : "空白页面"}</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
        {templateError && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">模板加载失败：{templateError}。仍可创建空白页面。</p>}
        {picked && (
          <div className="mt-3 max-h-48 overflow-auto rounded-xl bg-subtle p-3 ring-1 ring-line">
            <p className="text-xs text-fg-muted">{picked.description || "模板内容"}</p>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs text-fg-2">{picked.body}</pre>
          </div>
        )}
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
    <Dialog onClose={onClose} className="max-w-md">
      <div className="px-5 pt-5 pb-4 space-y-3">
        <div className="mb-4">
          <h2 className={dialogTitle}>导入页面</h2>
          <p className={dialogDesc}>把旧文档文件转成 Markdown 放进来</p>
        </div>
        <input autoFocus className={input} placeholder="页面标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value)} className={select}>
          {source.map(t => <option key={t} value={t}>{t === "markdown" ? "Markdown (原样)" : "MediaWiki"}</option>)}
        </select>
        <input
          type="file"
          accept={type === "markdown" ? ".md,.markdown,.txt" : ".txt,.wiki,.mediawiki,.md"}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm text-fg-muted file:mr-3 file:h-8 file:rounded-lg file:border-0 file:bg-shade file:px-3 file:text-[13px] file:font-medium file:text-fg hover:file:bg-subtle"
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
