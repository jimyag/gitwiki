import { useEffect } from "react";
import { api } from "./lib/api";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { TopBar } from "./components/TopBar";
import { Toaster } from "sonner";

export function App() {
  const setUser = useStore(s => s.setUser);
  const setRepos = useStore(s => s.setRepos);
  const user = useStore(s => s.user);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);

  useEffect(() => {
    (async () => {
      const me = await api.me();
      if (!me.user) return;
      setUser(me.user);
      const repos = await api.repos();
      setRepos(repos);
      if (repos.length && !useStore.getState().currentRepo) {
        const slug = repos[0].slug;
        useStore.getState().setCurrentRepo(slug);
        const tree = await api.pageTree(slug);
        useStore.getState().setTree(tree);
      }
    })();
  }, []);

  useEffect(() => {
    if (!currentRepo) return;
    (async () => {
      const tree = await api.pageTree(currentRepo);
      useStore.getState().setTree(tree);
    })();
  }, [currentRepo]);

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="h-screen flex overflow-hidden bg-stone-50">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-hidden flex flex-col bg-white">
          {pageId ? <Editor key={pageId} /> : <EmptyState />}
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-sm">
        <div className="inline-flex items-center justify-center size-12 rounded-full bg-stone-100 mb-4">
          <svg className="size-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>
        <h3 className="text-base font-medium text-stone-900 mb-1">没有选中内容</h3>
        <p className="text-sm text-stone-500">从左侧选择页面,或者新建一个</p>
        <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-stone-400">
          <kbd className="px-1.5 py-0.5 rounded border border-stone-200 bg-white font-mono text-[10px]">⌘S</kbd>
          <span>保存</span>
        </div>
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
        <p className="text-sm text-stone-500 mb-8 leading-relaxed">基于 GitHub 的 Wiki 协作编辑</p>
        <a
          href="/login"
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition shadow-sm"
        >
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2.15c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.97.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.9-.39 2.88-.39.97 0 1.96.13 2.88.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.35.78 1.04.78 2.1v3.11c0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
          用 GitHub 登录
        </a>
        <p className="text-xs text-stone-400 mt-6">请求 repo + user:email 权限,所有提交以你的身份产生</p>
      </div>
    </div>
  );
}
