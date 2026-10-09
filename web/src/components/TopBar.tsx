import { lazy, Suspense, useState, useEffect } from "react";
import { useCanWrite, useStore } from "../store";
import { api, loginUrl, type PageMeta, type PageRef } from "../lib/api";
import { descendants, pagePath, parentOf } from "../lib/tree";
import { HOME } from "../lib/route";
import { deletePage, movePage } from "../lib/actions";
import { isFavorite, toggleFavorite } from "../lib/recents";
import {
  RefreshCw, Check, AlertTriangle, Loader2, Pencil, ArrowUp, ArrowDown, Trash2, Plus,
  MoreHorizontal, Menu as MenuIcon, CloudOff, FolderInput, Eye, Printer, FileDown,
  Copy, ExternalLink, History, MessageSquare, Paperclip, Star, FoldHorizontal, UnfoldHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { NewPageDialog, SyncDialog } from "./Sidebar";
import { PagePicker } from "./PagePicker";
import {
  Avatar, Dialog, Menu, btnDanger, btnGhost, btnPrimary, chipAmber, chipNeutral, chipRed,
  dialogDesc, dialogFooter, dialogTitle, iconBtn, input, type MenuEntry,
} from "./ui";

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

const HealthNotice = lazy(() => import("./HealthNotice"));

// The page's everyday actions on the bar, named once it has room (icons with tooltips below
// that); the rarer ones stay in the menu.
const action = "inline-flex items-center gap-1.5 h-8 px-2 rounded-lg text-[13px] text-fg-muted whitespace-nowrap transition-colors hover:bg-shade hover:text-fg disabled:opacity-30 disabled:pointer-events-none";
const actionLabel = "hidden xl:inline";

// The bar at the top of the page panel: where the page sits, who else is here, the page's own
// actions (portaled in by Editor) and its menu.
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
  const wide = useStore(s => s.pageWide);
  const setWide = useStore(s => s.setPageWide);
  const peers = useStore(s => s.peers);
  const canWrite = useCanWrite();

  const [dialog, setDialog] = useState<"create" | "rename" | "move" | "delete" | "sync" | null>(null);
  const [fav, setFav] = useState(false);
  useEffect(() => {
    if (currentRepo && currentPageId) setFav(isFavorite(currentRepo, currentPageId));
  }, [currentRepo, currentPageId]);

  const isHome = currentPageId === HOME;
  const ctx = findNode(tree, currentPageId);
  const path = pagePath(tree, currentPageId);
  // The tree node of the open page; the root stands for the home page, which may not exist yet.
  const node = isHome ? tree : ctx?.node;
  const hasPage = !!currentRepo && !!node?.has_body;
  const site = useStore(s => s.settings?.site_url);
  const siteUrl = site && hasPage && !node?.draft
    ? site.replace(/\/+$/, "") + (isHome ? "/" : `/${currentPageId}/`)
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

  // On phones the bar keeps only 编辑 and this menu; the actions it shows from sm up move in
  // (sm:hidden there).
  const narrow = "sm:hidden";
  const menu: MenuEntry[] = [
    ...(user ? [{ label: "评论", icon: <MessageSquare />, onClick: () => setPanel("comments"), className: narrow }] : []),
    { label: "页面历史", icon: <History />, onClick: () => setPanel("history"), disabled: !hasPage, className: narrow },
    { label: "附件", icon: <Paperclip />, onClick: () => setPanel("assets"), className: narrow },
    ...(canFav ? [{ label: fav ? "取消收藏" : "收藏", icon: <Star />, onClick: toggleFav, className: narrow }] : []),
    ...(siteUrl ? [{ label: "在站点中查看", icon: <ExternalLink />, href: siteUrl }] : []),
    ...(hasPage && currentRepo && currentPageId ? [
      { label: "Markdown 源文件", icon: <FileDown />, href: api.mdUrl(currentRepo, currentPageId) },
      { label: "打印 / 导出 PDF", icon: <Printer />, onClick: () => window.print() },
    ] : []),
    // Phones are full width anyway.
    wide
      ? { label: "恢复单页宽度", icon: <FoldHorizontal />, onClick: () => setWide(false), className: "max-md:hidden" }
      : { label: "铺满宽度", icon: <UnfoldHorizontal />, onClick: () => setWide(true), className: "max-md:hidden" },
    ...(ctx && canWrite ? [
      "-" as const,
      { label: "新建子页面", icon: <Plus />, onClick: () => setDialog("create"), className: narrow },
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
    <header className="h-12 shrink-0 flex items-center gap-1.5 px-2 sm:px-3 border-b border-line text-sm">
      <button onClick={() => setNavOpen(true)} title="页面列表" className={`${iconBtn} md:hidden`}>
        <MenuIcon className="size-4" />
      </button>

      {/* Breadcrumb of titles; ancestors collapse on narrow screens. */}
      <nav className="flex-1 min-w-0 flex items-center gap-0.5" aria-label="当前位置">
        {path.slice(0, -1).map(n => (
          <span key={n.id} className="hidden sm:flex items-center gap-0.5 min-w-0 shrink">
            <button
              onClick={() => n.has_body && openPage(n.id)}
              disabled={!n.has_body}
              className="truncate max-w-[12rem] rounded-md px-1.5 py-1 text-fg-muted transition-colors enabled:hover:bg-shade enabled:hover:text-fg"
            >{n.title}</button>
            <span className="shrink-0 text-fg-subtle/70">/</span>
          </span>
        ))}
        {path.length > 0 && (
          <span className="truncate px-1.5 font-medium text-fg">{path[path.length - 1].title}</span>
        )}
        {isHome && <span className="truncate px-1.5 font-medium text-fg">首页</span>}
      </nav>

      <Suspense fallback={null}><HealthNotice key={currentRepo} /></Suspense>

      {othersEditing.length > 0 && (
        <span title={othersEditing.map(p => p.name || p.user).join("、") + " 正在编辑这一页"} className={chipAmber}>
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          {othersEditing.length === 1
            ? <><span className="max-w-[6rem] truncate">{othersEditing[0].name || othersEditing[0].user}</span><span className="hidden sm:inline font-normal">正在编辑</span></>
            : <span>{othersEditing.length} 人正在编辑</span>}
        </span>
      )}

      {lastSavedBy !== null && user && lastSavedBy !== user.login && (
        <button onClick={handleRefresh} title="载入新版本" className={`${chipAmber} group transition-colors hover:bg-amber-500/20`}>
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          {lastSavedBy ? (
            <>
              <span className="max-w-[6rem] truncate">{lastSavedBy}</span>
              <span className="hidden sm:inline font-normal">更新了本页</span>
            </>
          ) : (
            <span>这页有新版本</span>
          )}
          <RefreshCw className="size-3 opacity-60 group-hover:opacity-100" />
        </button>
      )}

      {/* Normally the sidebar's cloud shows the sync; a failure is worth the bar's space. */}
      {canWrite && currentRepo && syncError && (
        <button onClick={() => setDialog("sync")} title="同步状态" className={`${chipRed} transition-colors hover:bg-red-500/15`}>
          <CloudOff className="size-3.5" /><span className="hidden sm:inline">同步失败</span>
        </button>
      )}

      {!canWrite && (
        <span title={user ? "你可以阅读，但没有编辑权限" : "登录后可编辑"} className={chipNeutral}>
          <Eye className="size-3.5" />只读
        </span>
      )}
      {!user && (
        <a href={loginUrl()} className="inline-flex items-center h-7 shrink-0 px-3 rounded-lg bg-ink text-xs font-medium text-ink-fg transition-colors hover:bg-ink/85">登录</a>
      )}

      {/* Who else has this page open. */}
      {others.length > 0 && (
        <div className="hidden sm:flex items-center -space-x-1.5 px-1" title={others.map(p => p.name || p.user).join("、") + " 也在看这一页"}>
          {others.slice(0, 3).map(p => <Avatar key={p.user} login={p.user} name={p.name} className="size-6 text-[10px] ring-2 ring-surface" />)}
          {others.length > 3 && <span className="size-6 rounded-full bg-subtle ring-2 ring-surface text-[10px] text-fg-muted flex items-center justify-center">+{others.length - 3}</span>}
        </div>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />

      {/* Editor portals the page's own actions (编辑 / 预览 / 保存) in here. */}
      <div id="page-actions" className="flex items-center gap-1.5 shrink-0" />

      {currentPageId && (
        <div className="hidden sm:flex items-center gap-0.5 shrink-0 pl-1">
          {user && (
            <button
              onClick={() => setPanel(panel === "comments" ? null : "comments")}
              title="评论"
              aria-pressed={panel === "comments"}
              className={action + (panel === "comments" ? " bg-shade" : "")}
            >
              {/* State colours go on the content: on the button they would tie with action's own text colour. */}
              <MessageSquare className={"size-4" + (panel === "comments" ? " text-fg" : "")} />
              <span className={actionLabel + (panel === "comments" ? " text-fg" : "")}>评论</span>
            </button>
          )}
          <button onClick={() => setPanel("history")} disabled={!hasPage} title="页面历史" className={action}>
            <History className="size-4" /><span className={actionLabel}>历史</span>
          </button>
          <button onClick={() => setPanel("assets")} title="附件" className={action}>
            <Paperclip className="size-4" /><span className={actionLabel}>附件</span>
          </button>
          {canFav && (
            <button onClick={toggleFav} title={fav ? "取消收藏" : "收藏"} aria-pressed={fav} className={action}>
              <Star className={"size-4" + (fav ? " text-amber-500 fill-amber-400" : "")} />
              <span className={actionLabel}>{fav ? "已收藏" : "收藏"}</span>
            </button>
          )}
          {ctx && canWrite && (
            <button onClick={() => setDialog("create")} title="新建子页面" className={action}>
              <Plus className="size-4" /><span className={actionLabel}>新建子页面</span>
            </button>
          )}
        </div>
      )}
      {currentPageId && (
        <Menu entries={menu} label="更多操作" buttonClass={action}>
          <MoreHorizontal className="size-4" /><span className={actionLabel}>更多操作</span>
        </Menu>
      )}

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
      {dialog === "sync" && currentRepo && <SyncDialog key={currentRepo} slug={currentRepo} onClose={() => setDialog(null)} />}
    </header>
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
        <h2 className={dialogTitle}>重命名</h2>
        <p className={dialogDesc}>只改标题，页面地址不变</p>
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
      <div className="px-5 pt-5 pb-4">
        <h2 className={dialogTitle}>删除「{node.title}」？</h2>
        <p className={dialogDesc}>
          {kids > 0 ? <>会一起删除它下面的 <b className="font-semibold text-fg">{kids}</b> 个子页面和所有附件。</> : "会一起删除它的附件。"}
          删除后可以在侧栏的“回收站”里恢复。
        </p>
        {refs === null && <p className="mt-3 text-xs text-fg-subtle">正在检查哪些页面链接到这里…</p>}
        {!!refs?.length && (
          <div className="mt-3 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-500/25 dark:text-amber-200">
            <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4 shrink-0" />有 {refs.length} 个页面链接到这里，删除后这些链接会失效：</p>
            <ul className="mt-1.5 list-disc list-inside pl-1 text-[13px]">
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

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  const base = "inline-flex items-center gap-1.5 shrink-0 px-1.5 text-xs";
  if (status === "saving") {
    return <div className={`${base} text-fg-muted`}><Loader2 className="size-3.5 animate-spin" /><span className="hidden sm:inline">保存中</span></div>;
  }
  if (status === "saved") {
    return <div className={`${base} text-accent-strong`}><Check className="size-3.5" /><span className="hidden sm:inline">已保存</span></div>;
  }
  if (status === "conflict") {
    return <div className={chipRed}><AlertTriangle className="size-3" />有冲突</div>;
  }
  if (status === "error") {
    return <div className={chipRed}>保存出错</div>;
  }
  if (dirty) return <div className={`${base} text-fg-muted`}><span className="size-1.5 rounded-full bg-amber-500" /><span className="hidden sm:inline">未保存</span></div>;
  return null;
}
