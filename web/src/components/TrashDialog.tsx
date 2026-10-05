import { useEffect, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api, type Change } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { Avatar, Dialog, btnOutline } from "./ui";

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
    <Dialog onClose={onClose} className="max-w-lg">
      <div className="h-12 px-4 border-b border-stone-200 flex items-center gap-2">
        <Trash2 className="size-4 text-stone-400" />
        <h3 className="text-sm font-medium text-stone-900">回收站</h3>
        <span className="text-xs text-stone-400">列出的页面都可以恢复</span>
        <button onClick={onClose} title="关闭" className="ml-auto p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100">
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-[50vh] overflow-y-auto divide-y divide-stone-100">
        {items === null ? (
          <div className="px-5 py-10 text-center text-sm text-stone-400">加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-stone-400">还没有被删除的页面</div>
        ) : items.map(c => (
          <div key={`${c.id}:${c.sha}`} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar login={c.author} className="size-7 text-[11px]" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-stone-800 truncate">{c.title}</div>
              <div className="text-xs text-stone-400 truncate">{c.author} 删除于 <span title={new Date(c.date).toLocaleString()}>{formatRelativeTime(c.date)}</span></div>
            </div>
            {canWrite && (
              <button onClick={() => void restore(c)} className={`${btnOutline} shrink-0`}>
                <RotateCcw className="size-3.5" />恢复
              </button>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
