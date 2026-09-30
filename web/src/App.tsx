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
    <div className="h-screen flex flex-col bg-neutral-100">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden flex flex-col bg-white my-3 mr-3 rounded-xl shadow-sm ring-1 ring-black/5">
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
      <div className="text-center space-y-4 max-w-sm">
        <div className="inline-flex items-center justify-center size-16 rounded-2xl bg-gradient-to-br from-sky-100 to-violet-100 text-3xl">
          📝
        </div>
        <div>
          <h3 className="text-lg font-medium text-neutral-800">开始编辑</h3>
          <p className="text-sm text-neutral-500 mt-1">从左侧选择页面，或者新建一个页面</p>
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-neutral-400">
          <kbd className="px-1.5 py-0.5 rounded border border-neutral-200 bg-neutral-50 font-mono">⌘</kbd>
          <span>+</span>
          <kbd className="px-1.5 py-0.5 rounded border border-neutral-200 bg-neutral-50 font-mono">S</kbd>
          <span className="ml-1">保存</span>
        </div>
      </div>
    </div>
  );
}

function LoginScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-neutral-50 via-white to-sky-50">
      <div className="text-center space-y-8 max-w-sm px-6">
        <div className="inline-flex items-center justify-center size-16 rounded-2xl bg-neutral-900 text-3xl shadow-lg">
          📖
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">gitwiki</h1>
          <p className="text-sm text-neutral-500 leading-relaxed">基于 GitHub 仓库的协作 Wiki 编辑器,保存即提交</p>
        </div>
        <a
          href="/login"
          className="inline-flex items-center gap-2.5 rounded-lg bg-neutral-900 text-white px-5 py-2.5 text-sm font-medium hover:bg-neutral-800 transition shadow-md hover:shadow-lg"
        >
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.55v-2.15c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.97.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18.92-.26 1.9-.39 2.88-.39.97 0 1.96.13 2.88.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.35.78 1.04.78 2.1v3.11c0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>
          用 GitHub 登录
        </a>
        <p className="text-xs text-neutral-400 leading-relaxed">我们只申请 repo 与 user:email scope,所有提交以你的身份产生</p>
      </div>
    </div>
  );
}
