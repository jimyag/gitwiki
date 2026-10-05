import { useEffect, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../store";
import { api, type Revision, type RevisionContent } from "../lib/api";
import { changeLabel, formatRelativeTime } from "../lib/format";
import { SideBySide } from "./editor/DiffView";
import { Avatar, Dialog, btnPrimary } from "./ui";

// The page's versions (the commits that changed its text), each comparable with the current
// text and restorable: restoring saves the old text as a new version, so nothing is lost.
export function HistoryPanel({ pageId, current, canRestore, onRestore, onClose }: {
  pageId: string;
  current: { title: string; body: string };
  canRestore: boolean;
  onRestore(rev: Revision, content: RevisionContent): Promise<void>;
  onClose(): void;
}) {
  const repo = useStore(s => s.currentRepo);
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [sel, setSel] = useState<Revision | null>(null);
  const [content, setContent] = useState<RevisionContent | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!repo) return;
    api.history(repo, pageId).then(
      (r) => { setRevs(r); setSel(r[1] ?? r[0] ?? null); }, // the previous version is the useful default
      (e: Error) => { toast.error(`读取历史失败：${e.message}`); setRevs([]); },
    );
  }, [repo, pageId]);

  useEffect(() => {
    if (!repo || !sel) return;
    let live = true;
    setContent(null);
    api.revision(repo, pageId, sel.sha).then(c => live && setContent(c), (e: Error) => live && toast.error(e.message));
    return () => { live = false; };
  }, [repo, pageId, sel]);

  const restore = async () => {
    if (!sel || !content) return;
    setRestoring(true);
    try {
      await onRestore(sel, content);
    } finally {
      setRestoring(false);
    }
  };

  const isCurrent = sel !== null && sel === revs?.[0];
  return (
    <Dialog onClose={onClose} center className="max-w-6xl h-[88dvh] flex flex-col">
      <div className="h-12 shrink-0 px-4 border-b border-stone-200 flex items-center gap-2">
        <History className="size-4 text-stone-400" />
        <h3 className="text-sm font-medium text-stone-900">页面历史</h3>
        {revs && <span className="text-xs text-stone-400">{revs.length} 个版本</span>}
        <button onClick={onClose} title="关闭" className="ml-auto p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <ol className="md:w-72 shrink-0 max-h-44 md:max-h-none overflow-auto border-b md:border-b-0 md:border-r border-stone-200 p-2 space-y-px">
          {revs === null && <li className="p-3 text-xs text-stone-400">加载中…</li>}
          {revs?.map((r, i) => (
            <li key={r.sha}>
              <button
                onClick={() => setSel(r)}
                className={"w-full flex items-start gap-2.5 text-left rounded-md px-2.5 py-2 transition-colors " + (r === sel ? "bg-stone-100" : "hover:bg-stone-50")}
              >
                <Avatar login={r.author} className="size-6 text-[10px] mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[13px]">
                    <span className="font-medium text-stone-800 truncate">{r.author}</span>
                    {i === 0 && <span className="shrink-0 rounded bg-emerald-50 px-1.5 text-[11px] text-emerald-700">当前</span>}
                    <span className="ml-auto shrink-0 text-xs text-stone-400" title={new Date(r.date).toLocaleString()}>{formatRelativeTime(r.date)}</span>
                  </span>
                  <span className="block mt-0.5 text-xs text-stone-500 truncate">{changeLabel(r.message, r.links_only)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <section className="flex-1 min-w-0 min-h-0 flex flex-col">
          {sel && (
            <div className="min-h-11 shrink-0 px-4 py-2 border-b border-stone-200 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
              <span>{new Date(sel.date).toLocaleString()} · {sel.author}</span>
              {content && content.title !== current.title && (
                <span>当时的标题：<span className="text-stone-800">{content.title}</span></span>
              )}
              {canRestore && !isCurrent && (
                <button onClick={() => void restore()} disabled={!content || restoring} className={`${btnPrimary} ml-auto`}>
                  <RotateCcw className="size-3.5" />{restoring ? "恢复中…" : "恢复此版本"}
                </button>
              )}
            </div>
          )}
          {content ? (
            <SideBySide
              theirs={content.body}
              ours={current.body}
              theirsLabel={isCurrent ? "当前版本" : "这个版本"}
              oursLabel="现在的内容"
            />
          ) : (
            <div className="flex-1 m-4 rounded-lg bg-stone-50 animate-pulse" />
          )}
        </section>
      </div>
    </Dialog>
  );
}
