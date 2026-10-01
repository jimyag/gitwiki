import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { api, loginUrl } from "./lib/api";
import { useStore } from "./store";
import { HOME, parseLocation, pathFor } from "./lib/route";
import { Sidebar, savedSidebarWidth } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { TopBar } from "./components/TopBar";
import { Toaster } from "sonner";
import { SearchModal } from "./components/SearchModal";
import { TagsModal } from "./components/TagsModal";
import { UploadBar } from "./components/UploadBar";

export function App() {
  const setUser = useStore(s => s.setUser);
  const setRepos = useStore(s => s.setRepos);
  const user = useStore(s => s.user);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const pageRev = useStore(s => s.pageRev);
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
    <div className="h-dvh flex overflow-hidden bg-white">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-hidden flex flex-col bg-white">
          {pageId ? <Editor key={`${pageId}:${pageRev}`} /> : !currentRepo && <NoRepos />}
        </main>
      </div>
      {/* top-center: top-right would sit on the page actions in the TopBar */}
      <Toaster richColors position="top-center" />
      <SearchHost />
      <TagsHost />
      <UploadBar />
    </div>
  );
}

function TagsHost() {
  const tag = useStore(s => s.tagsOpen);
  const setTagsOpen = useStore(s => s.setTagsOpen);
  return tag === null ? null : <TagsModal initial={tag} onClose={() => setTagsOpen(null)} />;
}

// Empty frame lined up with the real layout (sidebar width, 48px bars), so the app fills in
// place instead of swapping screens.
function BootShell() {
  return (
    <div className="h-dvh flex bg-white" aria-busy="true">
      <div className="hidden md:block shrink-0 bg-stone-50 border-r border-stone-200" style={{ width: savedSidebarWidth() }}>
        <div className="h-12 border-b border-stone-200" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="h-12 border-b border-stone-200" />
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
        <div className="inline-flex items-center justify-center size-11 rounded-xl bg-stone-100 mb-4">
          <BookOpen className="size-5 text-stone-400" />
        </div>
        <h3 className="text-base font-medium text-stone-900 mb-1">还没有你可以访问的 Wiki</h3>
        <p className="text-sm text-stone-500">请联系管理员为你开通权限。</p>
      </div>
    </div>
  );
}

function LoginScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50">
      <div className="text-center max-w-xs">
        <div className="inline-flex items-center justify-center size-12 rounded-xl bg-stone-900 mb-6 shadow-sm">
          <svg className="size-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900 mb-1.5">gitwiki</h1>
        <p className="text-sm text-stone-500 mb-8 leading-relaxed">团队 Wiki，多人在线协作编辑</p>
        <a
          href={loginUrl()}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition shadow-sm"
        >
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2.15c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.97.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.9-.39 2.88-.39.97 0 1.96.13 2.88.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.35.78 1.04.78 2.1v3.11c0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
          用 GitHub 登录
        </a>
      </div>
    </div>
  );
}
