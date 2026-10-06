import { useState, useEffect, useRef, type ReactNode } from "react";
import { useCanWrite, useRepoInfo, useStore } from "../store";
import { api, loginUrl, type PageMeta, type PageRef, type SyncStatus } from "../lib/api";
import { descendants, pagePath, parentOf } from "../lib/tree";
import { HOME } from "../lib/route";
import { deletePage, movePage } from "../lib/actions";
import { isFavorite, toggleFavorite } from "../lib/recents";
import {
  RefreshCw, Check, AlertTriangle, Loader2, Pencil, ArrowUp, ArrowDown, Trash2, Plus,
  MoreHorizontal, Menu, ChevronRight, CloudOff, FolderInput, Eye, Printer, FileDown,
  Copy, ExternalLink, History, MessageSquare, Paperclip, Star,
} from "lucide-react";
import { toast } from "sonner";
import { NewPageDialog } from "./Sidebar";
import { PagePicker } from "./PagePicker";
import { Avatar, Dialog, btnDanger, btnGhost, btnPrimary, dialogFooter, iconBtn, input } from "./ui";

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

const chip = "inline-flex items-center gap-1.5 h-7 shrink-0 px-2.5 rounded-full border text-xs";
const amberChip = `${chip} border-amber-200 bg-amber-50 text-amber-800`;

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
  const panel = useStore(s => s.panel);
  const setPanel = useStore(s => s.setPanel);
  const syncError = useStore(s => s.syncError);
  const peers = useStore(s => s.peers);
  const repoInfo = useRepoInfo();
  const canWrite = useCanWrite();

  const [dialog, setDialog] = useState<"create" | "rename" | "move" | "delete" | null>(null);
  const [fav, setFav] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    if (currentRepo && currentPageId) setFav(isFavorite(currentRepo, currentPageId));
  }, [currentRepo, currentPageId]);

  const isHome = currentPageId === HOME;
  const ctx = findNode(tree, currentPageId);
  const path = pagePath(tree, currentPageId);
  // The tree node of the open page; the root stands for the home page, which may not exist yet.
  const node = isHome ? tree : ctx?.node;
  const hasPage = !!currentRepo && !!node?.has_body;
  const siteUrl = repoInfo?.site_url && hasPage && !node?.draft
    ? repoInfo.site_url.replace(/\/+$/, "") + (isHome ? "/" : `/${currentPageId}/`)
    : null;
  // 其他人正在编辑同一页：点“编辑”前先提醒，不要互相撞车。
  const others = user ? peers.filter(p => p.user !== user.login) : [];
  const othersEditing = others.filter(p => p.editing);

  const copyPage = async () => {
    if (!currentRepo || !ctx) return;
    try {
      const res = await api.copyPage(currentRepo, ctx.node.id);
      await useStore.getState().refreshTree();
      toast.success("已复制");
      useStore.getState().openPage(res.id);
    } catch (e: any) {
      toast.error(`复制失败：${e.message}`);
    }
  };

  // Remounts the editor so body and base_sha are refetched together. Keeping the old body
  // with the new base_sha would make the next save silently overwrite the other edit.
  const handleRefresh = () => {
    if (dirty && !confirm("载入新版本后，你未保存的修改会留在本机草稿里，可以再恢复。继续？")) return;
    useStore.getState().reloadPage();
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

  const toggleFav = () => {
    if (currentRepo && currentPageId) setFav(toggleFavorite(currentRepo, currentPageId, node?.title ?? currentPageId));
  };
  const canFav = hasPage && !isHome;

  // On phones the bar keeps only 编辑 and this menu; the icons next to it move in (narrow).
  const menu: MenuEntry[] = [
    ...(user ? [{ label: "评论", icon: <MessageSquare />, onClick: () => setPanel("comments"), narrow: true }] : []),
    { label: "页面历史", icon: <History />, onClick: () => setPanel("history"), disabled: !hasPage, narrow: true },
    ...(canFav ? [{ label: fav ? "取消收藏" : "收藏", icon: <Star />, onClick: toggleFav, narrow: true }] : []),
    { label: "附件", icon: <Paperclip />, onClick: () => setPanel("assets") },
    ...(siteUrl ? [{ label: "在站点中查看", icon: <ExternalLink />, href: siteUrl }] : []),
    ...(hasPage && currentRepo && currentPageId ? [
      { label: "Markdown 源文件", icon: <FileDown />, href: api.mdUrl(currentRepo, currentPageId) },
      { label: "打印 / 导出 PDF", icon: <Printer />, onClick: () => window.print() },
    ] : []),
    ...(ctx && canWrite ? [
      "-" as const,
      { label: "新建子页面", icon: <Plus />, onClick: () => setDialog("create") },
      { label: "重命名", icon: <Pencil />, onClick: () => setDialog("rename") },
      { label: "移动到…", icon: <FolderInput />, onClick: () => setDialog("move") },
      { label: "上移", icon: <ArrowUp />, onClick: () => void reorder(-1), disabled: ctx.index === 0 },
      { label: "下移", icon: <ArrowDown />, onClick: () => void reorder(1), disabled: ctx.index === ctx.siblings.length - 1 },
      { label: "复制页面", icon: <Copy />, onClick: () => void copyPage() },
      "-" as const,
      { label: "删除页面", icon: <Trash2 />, onClick: () => setDialog("delete"), danger: true },
    ] : []),
  ];

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
        {isHome && <span className="truncate px-1 font-medium text-stone-900">首页</span>}
      </nav>

      {othersEditing.length > 0 && (
        <span title={othersEditing.map(p => p.name || p.user).join("、") + " 正在编辑这一页"} className={amberChip}>
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          {othersEditing.length === 1
            ? <><span className="font-medium max-w-[6rem] truncate">{othersEditing[0].name || othersEditing[0].user}</span><span className="hidden sm:inline">正在编辑</span></>
            : <span>{othersEditing.length} 人正在编辑</span>}
        </span>
      )}

      {lastSavedBy !== null && user && lastSavedBy !== user.login && (
        <button onClick={handleRefresh} title="载入新版本" className={`${amberChip} group hover:bg-amber-100 transition`}>
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

      {canWrite && currentRepo && (
        <button onClick={() => setSyncOpen(true)} title="同步状态" className={`${chip} ${syncError ? "border-red-200 bg-red-50 text-red-700" : "border-stone-200 text-stone-600 hover:bg-stone-50"}`}>
          {syncError ? <CloudOff className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          <span className="hidden sm:inline">{syncError ? "同步失败" : "同步状态"}</span>
        </button>
      )}

      {!canWrite && (
        <span title={user ? "你可以阅读，但没有编辑权限" : "登录后可编辑"} className={`${chip} border-transparent bg-stone-100 text-stone-600`}>
          <Eye className="size-3.5" />只读
        </span>
      )}
      {!user && (
        <a href={loginUrl()} className={`${chip} border-transparent bg-emerald-600 text-white hover:bg-emerald-700 transition`}>登录</a>
      )}

      {/* Who else has this page open. */}
      {others.length > 0 && (
        <div className="hidden sm:flex items-center -space-x-1.5 px-1" title={others.map(p => p.name || p.user).join("、") + " 也在看这一页"}>
          {others.slice(0, 3).map(p => <Avatar key={p.user} login={p.user} name={p.name} className="size-6 text-[10px] ring-2 ring-white" />)}
          {others.length > 3 && <span className="size-6 rounded-full bg-stone-100 ring-2 ring-white text-[10px] text-stone-600 flex items-center justify-center">+{others.length - 3}</span>}
        </div>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />

      {/* Editor portals the page's own actions (编辑 / 预览 / 保存) in here. */}
      <div id="page-actions" className="flex items-center gap-1 shrink-0" />

      {currentPageId && (
        <div className="hidden sm:flex items-center shrink-0">
          {user && (
            <button
              onClick={() => setPanel(panel === "comments" ? null : "comments")}
              title="评论"
              aria-pressed={panel === "comments"}
              className={iconBtn + (panel === "comments" ? " bg-stone-100" : "")}
            >
              {/* State colours go on the icon: on the button they would tie with iconBtn's own text colour. */}
              <MessageSquare className={"size-4" + (panel === "comments" ? " text-stone-900" : "")} />
            </button>
          )}
          <button onClick={() => setPanel("history")} disabled={!hasPage} title="页面历史" className={iconBtn}>
            <History className="size-4" />
          </button>
          {canFav && (
            <button onClick={toggleFav} title={fav ? "取消收藏" : "收藏"} className={iconBtn}>
              <Star className={"size-4" + (fav ? " text-amber-500 fill-amber-400" : "")} />
            </button>
          )}
        </div>
      )}
      {currentPageId && <MoreMenu entries={menu} />}

      {dialog === "create" && ctx && <NewPageDialog parentId={ctx.node.id} onClose={() => setDialog(null)} />}
      {dialog === "rename" && ctx && <RenameDialog node={ctx.node} onClose={() => setDialog(null)} />}
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
      {syncOpen && currentRepo && canWrite && <SyncDialog key={currentRepo} slug={currentRepo} onClose={() => setSyncOpen(false)} />}
    </header>
  );
}

function SyncDialog({ slug, onClose }: { slug: string; onClose(): void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api.syncStatus(slug);
        if (!cancelled) { setStatus(next); setError(null); }
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
  return (
    <Dialog onClose={onClose}>
      <div className="p-5 space-y-4">
        <h2 className="text-base font-semibold text-stone-900">同步状态</h2>
        <p className="text-sm text-stone-500">每分钟检查 GitHub 上的更改，已保存的修改会自动推送。</p>
        {status ? (
          <dl className="space-y-2 text-sm text-stone-700" aria-live="polite">
            <div className="flex justify-between gap-3"><dt>最近成功拉取</dt><dd>{status.last_pull ? new Date(status.last_pull).toLocaleString() : "尚未成功拉取"}</dd></div>
            <div className="flex justify-between gap-3"><dt>待推送提交</dt><dd>{status.pending} 个</dd></div>
            <div className="flex justify-between gap-3"><dt>当前状态</dt><dd>{busy ? "同步中…" : status.pull_error || status.push_error ? "同步失败，会自动重试" : "空闲"}</dd></div>
          </dl>
        ) : !error && <p className="text-sm text-stone-500">加载中…</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {status?.pull_error && <p role="alert" className="text-sm text-red-700 whitespace-pre-wrap break-all">拉取失败：{status.pull_error}</p>}
        {status?.push_error && <p role="alert" className="text-sm text-red-700 whitespace-pre-wrap break-all">推送失败：{status.push_error}</p>}
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

function RenameDialog({ node, onClose }: { node: PageMeta; onClose(): void }) {
  const repo = useStore(s => s.currentRepo);
  const [value, setValue] = useState(node.title);

  const rename = async () => {
    if (repo && value.trim() && value !== node.title) {
      try {
        await api.retitlePage(repo, node.id, value.trim());
        await useStore.getState().refreshTree();
        toast.success("已重命名");
      } catch (e: any) { toast.error(`重命名失败：${e.message}`); }
    }
    onClose();
  };

  return (
    <Dialog onClose={onClose}>
      <div className="px-5 pt-5 pb-4">
        <h3 className="text-sm font-semibold text-stone-900">重命名</h3>
        <p className="mt-0.5 text-xs text-stone-500">只改标题，页面地址不变</p>
        <input
          autoFocus
          className={`${input} mt-4`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void rename(); }}
        />
      </div>
      <div className={dialogFooter}>
        <button onClick={onClose} className={btnGhost}>取消</button>
        <button onClick={() => void rename()} className={btnPrimary}>确定</button>
      </div>
    </Dialog>
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
    <Dialog onClose={onClose} className="max-w-md">
      <div className="px-5 pt-5 pb-4 space-y-2 text-sm text-stone-600">
        <h3 className="font-semibold text-stone-900">删除「{node.title}」？</h3>
        <p>
          {kids > 0 ? <>会一起删除它下面的 <b className="font-semibold text-stone-900">{kids}</b> 个子页面和所有附件。</> : "会一起删除它的附件。"}
          删除后可以在侧栏的“回收站”里恢复。
        </p>
        {refs === null && <p className="text-xs text-stone-400">正在检查哪些页面链接到这里…</p>}
        {!!refs?.length && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-amber-900">
            <p>有 {refs.length} 个页面链接到这里，删除后这些链接会失效：</p>
            <ul className="mt-1 list-disc list-inside pl-1 text-[13px]">
              {refs.slice(0, 5).map(r => <li key={r.id} className="truncate">{r.title}</li>)}
              {refs.length > 5 && <li>…等 {refs.length} 个</li>}
            </ul>
          </div>
        )}
      </div>
      <div className={dialogFooter}>
        <button onClick={onClose} className={btnGhost}>取消</button>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); if (await deletePage(node.id)) onClose(); else setBusy(false); }}
          className={btnDanger}
        >{busy ? "删除中…" : "删除"}</button>
      </div>
    </Dialog>
  );
}

interface MenuItem {
  label: string;
  icon: ReactNode;
  onClick?(): void;
  href?: string; // opens in a new tab instead
  disabled?: boolean;
  danger?: boolean;
  narrow?: boolean; // only listed on small screens, where the bar has no room for its icon
}
type MenuEntry = MenuItem | "-";

function MoreMenu({ entries }: { entries: MenuEntry[] }) {
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

  const item = "w-full flex items-center gap-2.5 h-8 px-2 rounded-md text-[13px] text-left transition disabled:opacity-35 disabled:pointer-events-none [&>svg]:size-4 [&>svg]:shrink-0 ";
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen(o => !o)} title="更多操作" aria-haspopup="menu" aria-expanded={open} className={iconBtn + (open ? " bg-stone-100" : "")}>
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 z-30 w-52 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-lg border border-stone-200 bg-white p-1 shadow-lg">
          {entries.map((it, i) => {
            if (it === "-") return <div key={i} role="separator" className="my-1 h-px bg-stone-100" />;
            const cls = item + (it.danger ? "text-red-600 hover:bg-red-50 [&>svg]:text-red-500 " : "text-stone-700 hover:bg-stone-100 [&>svg]:text-stone-400 ") + (it.narrow ? "sm:hidden" : "");
            return it.href ? (
              <a key={it.label} role="menuitem" href={it.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={cls}>
                {it.icon}{it.label}
              </a>
            ) : (
              <button key={it.label} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick?.(); }} className={cls}>
                {it.icon}{it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  const base = "inline-flex items-center gap-1.5 shrink-0 px-1 text-xs";
  if (status === "saving") {
    return <div className={`${base} text-stone-500`}><Loader2 className="size-3.5 animate-spin" /><span className="hidden sm:inline">保存中</span></div>;
  }
  if (status === "saved") {
    return <div className={`${base} text-emerald-700`}><Check className="size-3.5" /><span className="hidden sm:inline">已保存</span></div>;
  }
  if (status === "conflict") {
    return <div className={`${chip} border-red-200 bg-red-50 text-red-700 font-medium`}><AlertTriangle className="size-3" />有冲突</div>;
  }
  if (status === "error") {
    return <div className={`${chip} border-red-200 bg-red-50 text-red-700 font-medium`}>保存出错</div>;
  }
  if (dirty) return <div className={`${base} text-stone-400`}><span className="size-1.5 rounded-full bg-stone-400" /><span className="hidden sm:inline">未保存</span></div>;
  return null;
}
