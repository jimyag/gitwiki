import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api, type Change } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { btnGhost, btnOutline, overlay } from "./ui";

// 单独的回收站：最近更新只留 30 条，老删除会被新改动挤掉；这里列的才是完整的删除清单。
export function TrashDialog({ onClose }: { onClose(): void }) {
  const repo = useStore(s => s.currentRepo);
  const canWrite = useCanWrite();
  const [items, setItems] = useState<Change[] | null>(null);

  useEffect(() => {
    if (!repo) return;
    api.trash(repo).then(setItems, () => setItems([]));
  }, [repo]);

  const restore = async (c: Change) => {
    if (!repo) return;
    try {
      await api.restorePage(repo, c.id, c.sha);
      await useStore.getState().refreshTree();
      setItems(prev => prev?.filter(x => x.id !== c.id) ?? null);
      toast.success(`已恢复「${c.title}」`);
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
  };

  return (
    <div className={`${overlay} flex items-start justify-center pt-[10vh] px-4`} onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 flex items-center gap-2">
          <Trash2 className="size-4 text-stone-400" />
          <h3 className="font-semibold text-sm text-stone-900">回收站</h3>
          <span className="text-xs text-stone-400">列出的页面都可以恢复</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto border-y border-stone-100 divide-y divide-stone-50">
          {items === null ? (
            <div className="px-5 py-8 text-center text-sm text-stone-400">加载中…</div>
          ) : items.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-stone-400">还没有被删除的页面</div>
          ) : items.map(c => (
            <div key={`${c.id}:${c.sha}`} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-stone-700 truncate">{c.title}</div>
                <div className="text-xs text-stone-400 truncate">{c.author} · <span title={new Date(c.date).toLocaleString()}>{formatRelativeTime(c.date)}</span></div>
              </div>
              {canWrite && (
                <button onClick={() => void restore(c)} className={`${btnOutline} h-7 shrink-0`}>
                  <RotateCcw className="size-3.5" />恢复
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="px-5 py-3 flex justify-end">
          <button onClick={onClose} className={btnGhost}>关闭</button>
        </div>
      </div>
    </div>
  );
}
