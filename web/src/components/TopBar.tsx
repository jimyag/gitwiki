import { useStore } from "../store";
import { RefreshCw, Check, AlertTriangle, Loader2 } from "lucide-react";
import { connectPresence } from "../lib/ws";
import { api } from "../lib/api";

export function TopBar() {
  const user = useStore(s => s.user);
  const currentRepo = useStore(s => s.currentRepo);
  const saveStatus = useStore(s => s.saveStatus);
  const dirty = useStore(s => s.dirty);
  const lastSavedBy = useStore(s => s.lastSavedBy);
  const currentPageId = useStore(s => s.currentPageId);
  const clearSavedBanner = useStore(s => s.clearSavedBanner);

  if (!user) return null;

  const handleRefresh = async () => {
    if (!currentRepo || !currentPageId) return;
    const pc = await api.readPage(currentRepo, currentPageId);
    useStore.getState().openPage(pc.id, pc.base_sha, pc.is_bundle);
    clearSavedBanner();
    connectPresence(currentRepo, currentPageId);
  };

  return (
    <header className="h-12 bg-white border-b border-stone-200 flex items-center px-6 gap-3 text-sm shrink-0">
      {/* Breadcrumb-style position */}
      <div className="text-xs text-stone-500 font-mono truncate max-w-xs">
        {currentPageId ?? ""}
      </div>

      <div className="flex-1" />

      {lastSavedBy && lastSavedBy !== user.login && (
        <button
          onClick={handleRefresh}
          className="group inline-flex items-center gap-2 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition"
          title="点击查看最新版本"
        >
          <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span className="font-medium">{lastSavedBy}</span> 保存了新版本
          <RefreshCw className="size-3 opacity-50 group-hover:opacity-100" />
        </button>
      )}

      <StatusIndicator status={saveStatus} dirty={dirty} />
    </header>
  );
}

function StatusIndicator({ status, dirty }: { status: string; dirty: boolean }) {
  if (status === "saving") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-stone-500">
        <Loader2 className="size-3 animate-spin" />
        保存中
      </div>
    );
  }
  if (status === "saved") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
        <Check className="size-3.5" />
        已保存
      </div>
    );
  }
  if (status === "conflict") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium">
        <AlertTriangle className="size-3" />
        有冲突
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-medium">
        出错
      </div>
    );
  }
  if (dirty) {
    return <div className="text-xs text-stone-400">未保存</div>;
  }
  return null;
}
