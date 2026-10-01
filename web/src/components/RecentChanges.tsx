import { useEffect, useState } from "react";
import { Clock, FileText, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api, type Change } from "../lib/api";
import { changeLabel, formatRelativeTime } from "../lib/format";
import { pathFor } from "../lib/route";
import { btnOutline } from "./ui";

// The home page's "最近更新": the latest change of each page, deleted pages included, which
// can be restored from here (git keeps them).
export function RecentChanges() {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree); // replaced after every change in the wiki: time to reload
  const canWrite = useCanWrite();
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    if (!repo) return;
    let live = true;
    api.recent(repo).then(c => live && setChanges(c), () => live && setChanges([]));
    return () => { live = false; };
  }, [repo, tree]);

  const restore = async (c: Change) => {
    if (!repo) return;
    try {
      await api.restorePage(repo, c.id, c.sha);
      await useStore.getState().refreshTree();
      toast.success(`已恢复「${c.title}」`);
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
  };

  if (!repo || !changes?.length) return null;
  return (
    <section className="mt-16">
      <h2 className="flex items-center gap-2 mb-2 text-sm font-semibold text-stone-900">
        <Clock className="size-4 text-stone-400" />最近更新
      </h2>
      <ul className="divide-y divide-stone-100 border-y border-stone-100">
        {changes.map(c => (
          <li key={c.id} className="flex items-center gap-3 py-2.5">
            {c.deleted
              ? <Trash2 className="size-4 shrink-0 text-stone-300" />
              : <FileText className="size-4 shrink-0 text-stone-400" />}
            <div className="min-w-0 flex-1">
              {c.deleted ? (
                <span className="text-[15px] text-stone-400 line-through decoration-stone-300">{c.title}</span>
              ) : (
                <a
                  href={pathFor(repo, c.id)}
                  onClick={(e) => { e.preventDefault(); useStore.getState().openPage(c.id); }}
                  className="text-[15px] font-medium text-stone-800 hover:text-emerald-700 transition"
                >{c.title}</a>
              )}
              <div className="text-xs text-stone-400 truncate">
                {c.author} {changeLabel(c.message)} · <span title={new Date(c.date).toLocaleString()}>{formatRelativeTime(c.date)}</span>
              </div>
            </div>
            {c.deleted && canWrite && (
              <button onClick={() => void restore(c)} className={`${btnOutline} h-7 shrink-0`}>
                <RotateCcw className="size-3.5" />恢复
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
