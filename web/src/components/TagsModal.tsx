import { useEffect, useMemo, useState } from "react";
import { FileText, Tag, X } from "lucide-react";
import { useStore } from "../store";
import { flattenTree, type FlatPage } from "../lib/tree";
import { overlay } from "./ui";

// Browse pages by their front matter tags (the same tags Hugo builds taxonomy pages from).
export function TagsModal({ initial, onClose }: { initial: string; onClose(): void }) {
  const tree = useStore(s => s.tree);
  const tags = useMemo(() => {
    const byTag = new Map<string, FlatPage[]>();
    for (const p of flattenTree(tree)) {
      for (const t of p.node.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), p]);
    }
    return [...byTag].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
  }, [tree]);
  const [sel, setSel] = useState(initial);
  const selected = tags.find(([t]) => t === sel) ?? tags[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={`${overlay} flex items-start justify-center pt-[12vh] px-4`} onClick={onClose}>
      <div className="w-full max-w-[560px] bg-white rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-stone-200 flex items-center gap-2">
          <Tag className="size-4 text-stone-400" />
          <h3 className="text-sm font-medium text-stone-900">标签</h3>
          <span className="text-xs text-stone-400">{tags.length} 个</span>
          <button onClick={onClose} title="关闭" className="ml-auto p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100">
            <X className="size-4" />
          </button>
        </div>
        {tags.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-stone-400">还没有页面设置标签。编辑页面时可以在标题下面添加。</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 p-4 border-b border-stone-100">
              {tags.map(([t, pages]) => (
                <button
                  key={t}
                  onClick={() => setSel(t)}
                  className={
                    "inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[13px] transition " +
                    (t === selected?.[0] ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700 hover:bg-stone-200")
                  }
                >
                  {t}<span className={t === selected?.[0] ? "text-stone-300" : "text-stone-400"}>{pages.length}</span>
                </button>
              ))}
            </div>
            <ul className="max-h-[45vh] overflow-auto p-1.5">
              {selected?.[1].map(p => (
                <li key={p.id}>
                  <button
                    onClick={() => { if (useStore.getState().openPage(p.id)) onClose(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-stone-100"
                  >
                    <FileText className="size-3.5 shrink-0 text-stone-400" />
                    <span className="font-medium text-stone-900 truncate">{p.title}</span>
                    {p.where && <span className="ml-auto pl-2 text-xs text-stone-400 truncate">{p.where}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
