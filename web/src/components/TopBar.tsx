import { useStore } from "../store";
import { BookOpen, LogOut, Users } from "lucide-react";

export function TopBar() {
  const user = useStore(s => s.user);
  const repos = useStore(s => s.repos);
  const currentRepo = useStore(s => s.currentRepo);
  const setCurrentRepo = useStore(s => s.setCurrentRepo);
  const peers = useStore(s => s.peers);
  const dirty = useStore(s => s.dirty);
  const saveStatus = useStore(s => s.saveStatus);
  const lastSavedBy = useStore(s => s.lastSavedBy);
  const lastSavedSha = useStore(s => s.lastSavedSha);

  if (!user) return null;

  const statusText = saveStatus === "saving" ? "保存中…" :
    saveStatus === "saved" ? "已保存" :
    saveStatus === "conflict" ? "有冲突" :
    dirty ? "未保存" : "";

  return (
    <header className="h-12 border-b border-neutral-200 bg-white flex items-center px-4 gap-3 text-sm shrink-0">
      <div className="flex items-center gap-2 font-semibold">
        <BookOpen className="size-4" />
        gitwiki
      </div>
      <div className="flex items-center gap-1">
        <select
          className="text-sm rounded-md border border-neutral-200 bg-white px-2 py-1 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          value={currentRepo ?? ""}
          onChange={(e) => setCurrentRepo(e.target.value)}
        >
          {repos.map(r => <option key={r.slug} value={r.slug}>{r.title}</option>)}
        </select>
      </div>

      <div className="flex-1" />

      {peers.length > 1 && (
        <div className="flex items-center gap-1 text-xs text-neutral-500 mr-3">
          <Users className="size-3.5" />
          <span>{peers.length} 人正在查看</span>
          <div className="flex -space-x-1.5 ml-1">
            {peers.slice(0, 5).map(p => (
              <div key={p.user} title={p.name || p.user} className="size-5 rounded-full bg-gradient-to-br from-sky-500 to-violet-500 text-white flex items-center justify-center text-[10px] font-medium ring-2 ring-white">
                {(p.name || p.user).slice(0,1).toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      )}

      {lastSavedBy && lastSavedBy !== user.login && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
          {lastSavedBy} 已保存新版本 {lastSavedSha?.slice(0, 7)}
        </div>
      )}

      {statusText && (
        <div className={
          "text-xs px-2 py-0.5 rounded " +
          (saveStatus === "conflict" ? "bg-red-50 text-red-700 border border-red-200" :
           saveStatus === "saved" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
           dirty ? "text-amber-600" : "text-neutral-400")
        }>
          {statusText}
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="text-neutral-500 text-xs">@{user.login}</span>
        <a href="/logout" title="logout" className="text-neutral-400 hover:text-neutral-700">
          <LogOut className="size-4" />
        </a>
      </div>
    </header>
  );
}
