import { useEffect, useState } from "react";
import { BookOpen, Keyboard } from "lucide-react";
import { api, loginUrl } from "./lib/api";
import { useStore } from "./store";
import { HOME, parseLocation, pathFor } from "./lib/route";
import { useDark } from "./lib/theme";
import { Sidebar, savedSidebarWidth } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { TopBar } from "./components/TopBar";
import { Toaster } from "sonner";
import { SearchModal } from "./components/SearchModal";
import { TagsModal } from "./components/TagsModal";
import { UploadBar } from "./components/UploadBar";
import { Dialog, DialogHeader, Kbd, isMac, shortcutBlocked } from "./components/ui";

export function App() {
  const setUser = useStore(s => s.setUser);
  const setRepos = useStore(s => s.setRepos);
  const user = useStore(s => s.user);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const pageRev = useStore(s => s.pageRev);
  const dark = useDark();
  // Until /api/me answers we don't know who this is; showing the login screen meanwhile
  // made every reload of a logged-in user flash it.
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setUser(me.user);
        const repos = me.repos ?? [];
        setRepos(repos);
        // Open what the URL names. Read follows the URL slug: it works for logged-out
        // visitors on read_public repos; unknown slugs will fail at the tree fetch below.
        const want = parseLocation();
        const repo = want.repo ?? repos[0]?.slug ?? null;
        if (repo) {
          const page = repo === want.repo ? want.page : HOME;
          history.replaceState(null, "", pathFor(repo, page) + (repo === want.repo ? location.hash : ""));
          useStore.getState().goTo(repo, page);
        }
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  // Keep the address bar on the open repo/page; Back/Forward move between pages.
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.currentRepo === prev.currentRepo && s.currentPageId === prev.currentPageId) return;
      const path = pathFor(s.currentRepo, s.currentPageId);
      if (path !== location.pathname) history.pushState(null, "", path);
    });
    const onPop = () => {
      const { repo, page } = parseLocation();
      const st = useStore.getState();
      if (!repo || !st.repos.some(r => r.slug === repo)) return;
      // Staying on a page with unsaved changes: put its address back.
      if (!st.goTo(repo, page)) history.pushState(null, "", pathFor(st.currentRepo, st.currentPageId));
    };
    window.addEventListener("popstate", onPop);
    return () => {
      unsub();
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // Reloading now reopens the same page, but unsaved edits would still be lost: ask first.
  const dirty = useStore(s => s.dirty);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  useEffect(() => {
    if (currentRepo) void useStore.getState().refreshTree();
  }, [currentRepo]);

  if (!user && !authChecked) {
    return <BootShell />;
  }
  if (!user && authChecked && !currentRepo) {
    return <LoginScreen />;
  }

  return (
    // The sidebar sits on the canvas; the page is a panel raised above it (full width on phones).
    <div className="h-dvh flex overflow-hidden bg-canvas print:block print:h-auto print:overflow-visible">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col md:py-2 md:pr-2 print:block print:p-0">
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-surface md:rounded-xl md:shadow-panel print:block print:overflow-visible print:shadow-none">
          <TopBar />
          <main className="flex-1 min-h-0 flex flex-col print:block">
            {pageId ? <Editor key={`${pageId}:${pageRev}`} /> : !currentRepo && <NoRepos />}
          </main>
        </div>
      </div>
      {/* top-center: top-right would sit on the page actions in the TopBar */}
      <Toaster theme={dark ? "dark" : "light"} position="top-center" />
      <SearchHost />
      <TagsHost />
      <Shortcuts />
      <UploadBar />
    </div>
  );
}

// "/" searches and "?" lists the shortcuts; E (edit) belongs to the page, see Editor.
function Shortcuts() {
  const open = useStore(s => s.shortcutsOpen);
  const setOpen = useStore(s => s.setShortcutsOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutBlocked(e) || (e.key !== "/" && e.key !== "?")) return;
      e.preventDefault();
      if (e.key === "/") useStore.getState().setSearchOpen(true);
      else setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
  if (!open) return null;
  const mod = isMac ? "⌘" : "Ctrl ";
  const keys: [string, string[]][] = [
    ["搜索", [`${mod}K`, "/"]],
    ["编辑当前页面", ["E"]],
    ["保存", [`${mod}S`]],
    ["关闭对话框，清除搜索词标记", ["Esc"]],
    ["查看快捷键", ["?"]],
  ];
  const close = () => setOpen(false);
  return (
    <Dialog onClose={close} className="max-w-sm">
      <DialogHeader icon={Keyboard} title="键盘快捷键" onClose={close} />
      <ul className="p-2">
        {keys.map(([what, combo]) => (
          <li key={what} className="flex items-center justify-between gap-4 px-3 py-2 text-sm text-fg-2">
            {what}
            <span className="flex shrink-0 gap-1">{combo.map(k => <Kbd key={k}>{k}</Kbd>)}</span>
          </li>
        ))}
      </ul>
      <p className="px-5 pb-5 text-xs leading-relaxed text-fg-muted">编辑时在行首输入 / 可以插入标题、表格、提示块、Mermaid 图等，输入 [[ 可以链接到其他页面。</p>
    </Dialog>
  );
}

function TagsHost() {
  const tag = useStore(s => s.tagsOpen);
  const setTagsOpen = useStore(s => s.setTagsOpen);
  return tag === null ? null : <TagsModal initial={tag} onClose={() => setTagsOpen(null)} />;
}

// Empty frame lined up with the real layout (sidebar width, the raised panel), so the app fills
// in place instead of swapping screens.
function BootShell() {
  return (
    <div className="h-dvh flex bg-canvas" aria-busy="true">
      <div className="hidden md:block shrink-0" style={{ width: savedSidebarWidth() }} />
      <div className="flex-1 min-w-0 md:py-2 md:pr-2">
        <div className="h-full bg-surface md:rounded-xl md:shadow-panel" />
      </div>
    </div>
  );
}

function SearchHost() {
  const open = useStore(s => s.searchOpen);
  const setOpen = useStore(s => s.setSearchOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(!useStore.getState().searchOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
  return open ? <SearchModal onClose={() => setOpen(false)} /> : null;
}

function NoRepos() {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-subtle ring-1 ring-line">
          <BookOpen className="size-5 text-fg-subtle" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-fg">还没有你可以访问的 Wiki</h3>
        <p className="mt-1 text-sm leading-relaxed text-fg-muted">把 gitwiki 的 GitHub App 安装到文档仓库后，有仓库权限的人就能在这里看到它。</p>
      </div>
    </div>
  );
}

// The app's mark, the same as the favicon.
export function Logo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#059669" />
      <path d="M23 10.5A9 9 0 1 0 23 22V16h-7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoginScreen() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-2xl bg-surface px-8 pt-10 pb-8 text-center shadow-panel animate-pop-in">
        <Logo className="size-11 mx-auto" />
        <h1 className="mt-6 text-xl font-semibold text-fg">登录 gitwiki</h1>
        <p className="mt-2 text-sm leading-relaxed text-balance text-fg-muted">文档存在 Git 仓库里的团队 Wiki，多人在线协作编辑</p>
        <a
          href={loginUrl()}
          className="mt-8 flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-ink text-sm font-medium text-ink-fg shadow-xs transition-colors hover:bg-ink/85"
        >
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2.15c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.97.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.9-.39 2.88-.39.97 0 1.96.13 2.88.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.35.78 1.04.78 2.1v3.11c0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" /></svg>
          使用 GitHub 登录
        </a>
        <p className="mt-4 text-xs text-fg-subtle">阅读和编辑权限跟随 GitHub 仓库</p>
      </div>
    </div>
  );
}
