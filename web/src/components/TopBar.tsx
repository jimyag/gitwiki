import { useStore } from "../store";
import { BookOpen, LogOut, RefreshCw, Check } from "lucide-react";
import { connectPresence } from "../lib/ws";
import { api } from "../lib/api";

export function TopBar() {
  const user = useStore(s => s.user);
  const repos = useStore(s => s.repos);
  const currentRepo = useStore(s => s.currentRepo);
  const setCurrentRepo = useStore(s => s.setCurrentRepo);
  const peers = useStore(s => s.peers);
  const dirty = useStore(s => s.dirty);
  const saveStatus = useStore(s => s.saveStatus);
  const lastSavedBy = useStore(s => s.lastSavedBy);
  const currentPageId = useStore(s => s.currentPageId);
  const clearSavedBanner = useStore(s => s.clearSavedBanner);

  if (!user) return null;

  const handleRefresh = async () => {
    if (!currentRepo || !currentPageId) return;
    const pc = await api.readPage(currentRepo, currentPageId);
    // Force editor reload via remount
    useStore.getState().openPage(pc.id, pc.base_sha, pc.is_bundle);
    clearSavedBanner();
    connectPresence(currentRepo, currentPageId);
  };

  return (
    <header className="h-12 bg-neutral-100 flex items-center px-4 gap-3 text-sm shrink-0">
      <div className="flex items-center gap-2 font-semibold text-neutral-900">
        <BookOpen className="size-4 text-neutral-500" />
        gitwiki
      </div>
      <div className="text-neutral-300">/</div>
      <select
        className="text-sm rounded-md bg-transparent hover:bg-white px-2 py-1 focus:outline-none focus:bg-white focus:ring-1 focus:ring-neutral-300 transition font-medium text-neutral-700"
        value={currentRepo ?? ""}
        onChange={(e) => setCurrentRepo(e.target.value)}
      >
        {repos.map(r => <option key={r.slug} value={r.slug}>{r.title}</option>)}
      </select>

      <div className="flex-1" />

      {lastSavedBy && lastSavedBy !== user.login && (
        <button
          onClick={handleRefresh}
          className="group inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-900 border border-amber-200 hover:bg-amber-100 transition"
          title="点击查看最新版本"
        >
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          {lastSavedBy} 保存了新版本
          <RefreshCw className="size-3 opacity-50 group-hover:opacity-100" />
        </button>
      )}

      {peers.length > 1 && (
        <div className="flex items-center gap-2 mr-3">
          <div className="flex -space-x-1.5">
            {peers.slice(0, 5).map(p => (
              <div
                key={p.user}
                title={p.name || p.user}
                className="size-6 rounded-full bg-gradient-to-br from-sky-500 via-violet-500 to-fuchsia-500 text-white flex items-center justify-center text-[10px] font-semibold ring-2 ring-neutral-100"
              >
                {(p.name || p.user).slice(0,1).toUpperCase()}
              </div>
            ))}
          </div>
          <span className="text-xs text-neutral-400">{peers.length} 人正在编辑</span>
        </div>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />

      <div className="flex items-center gap-3 pl-2 border-l border-neutral-200 ml-1">
        <div className="size-6 rounded-full bg-gradient-to-br from-neutral-700 to-neutral-900 text-white flex items-center justify-center text-[10px] font-semibold">
          {user.login.slice(0, 1).toUpperCase()}
        </div>
        <a href="/logout" title="登出" className="text-neutral-400 hover:text-neutral-700 transition">
          <LogOut className="size-4" />
        </a>
      </div>
    </header>
  );
}

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  if (status === "saving") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
        <RefreshCw className="size-3 animate-spin" />
        保存中
      </div>
    );
  }
  if (status === "saved") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
        <Check className="size-3.5" />
        已保存
      </div>
    );
  }
  if (status === "conflict") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
        有冲突
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
        出错
      </div>
    );
  }
  if (dirty) {
    return <div className="text-xs text-amber-600 italic">未保存</div>;
  }
  return null;
}
