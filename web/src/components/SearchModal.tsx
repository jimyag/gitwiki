import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api, type SearchHit } from "../lib/api";
import { pagePath } from "../lib/tree";
import { Search, FileText, X } from "lucide-react";
import { overlay } from "./ui";

export function SearchModal({ onClose }: { onClose: () => void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const openPage = useStore(s => s.openPage);
  const tree = useStore(s => s.tree);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!currentRepo || !q.trim()) { setResults([]); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(async () => {
      try {
        const hits = await api.search(currentRepo, q.trim());
        if (live) { setResults(hits); setSelected(0); }
      } catch {
        if (live) setResults([]);
      } finally {
        if (live) setLoading(false);
      }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, currentRepo]);

  const selectResult = (r: SearchHit) => {
    if (openPage(r.page_id)) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && results[selected]) selectResult(results[selected]);
  };

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className={`${overlay} flex items-start justify-center pt-[12vh] px-4`} onClick={onClose}>
      <div className="w-full max-w-[600px] bg-white rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-stone-200">
          <Search className="size-4 text-stone-400 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索标题和正文，多个词用空格分开"
            className="flex-1 min-w-0 text-[15px] outline-none placeholder:text-stone-400"
          />
          {loading && <div className="size-3.5 border-2 border-stone-200 border-t-stone-500 rounded-full animate-spin" />}
          <button onClick={onClose} title="关闭" className="p-1 rounded text-stone-300 hover:text-stone-600"><X className="size-4" /></button>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-auto p-1.5">
          {results.length === 0 && q.trim() && !loading && (
            <div className="px-4 py-12 text-center text-sm text-stone-400">没有匹配“{q}”的页面</div>
          )}
          {results.length === 0 && !q.trim() && (
            <div className="px-4 py-12 text-center text-sm text-stone-400">输入关键字，标题匹配的页面排在前面</div>
          )}
          {results.map((r, i) => {
            // Where the page sits, by title; slugs are random so they tell the reader nothing.
            const where = pagePath(tree, r.page_id).slice(0, -1).map(n => n.title).join(" / ");
            return (
              <div
                key={r.page_id}
                onClick={() => selectResult(r)}
                onMouseMove={() => setSelected(i)}
                className={"px-3 py-2 rounded-lg cursor-pointer " + (i === selected ? "bg-stone-100" : "")}
              >
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <FileText className="size-3.5 text-stone-400 shrink-0" />
                  <span className="font-medium text-stone-900 truncate"><Highlight text={r.title} terms={r.terms} /></span>
                  {where && <span className="ml-auto pl-2 text-xs text-stone-400 truncate shrink-0 max-w-[40%]">{where}</span>}
                </div>
                {r.snippet && (
                  <div className="mt-1 pl-[22px] text-[13px] leading-relaxed text-stone-500 line-clamp-2">
                    <Highlight text={r.snippet} terms={r.terms} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-stone-100 flex items-center gap-3 text-[11px] text-stone-400">
          <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">↑↓</kbd> 选择</span>
          <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">⏎</kbd> 打开</span>
          <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">Esc</kbd> 关闭</span>
          {results.length > 0 && <span className="ml-auto">{results.length} 个页面</span>}
        </div>
      </div>
    </div>
  );
}

// Highlight marks every occurrence of the matched terms, ignoring case.
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? <mark key={i} className="bg-amber-100 text-stone-900 rounded-sm">{part}</mark> : part,
      )}
    </>
  );
}
