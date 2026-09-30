import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Search, FileText, X } from "lucide-react";

interface Result {
  page_id: string;
  title: string;
  line: number;
  snippet: string;
}

export function SearchModal({ onClose }: { onClose: () => void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const openPage = useStore(s => s.openPage);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!currentRepo || !q.trim()) { setResults([]); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/repos/${currentRepo}/search?q=${encodeURIComponent(q.trim())}`);
        const data = await r.json();
        setResults(Array.isArray(data) ? data : []);
        setSelected(0);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, currentRepo]);

  const selectResult = async (r: Result) => {
    if (!currentRepo) return;
    const pc = await api.readPage(currentRepo, r.page_id);
    openPage(pc.id, pc.base_sha, pc.is_bundle);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && results[selected]) { void selectResult(results[selected]); }
  };

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-start justify-center pt-24 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[560px] bg-white rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200">
          <Search className="size-4 text-stone-400 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面标题或正文…"
            className="flex-1 text-sm outline-none placeholder:text-stone-400"
          />
          {loading && <div className="size-3 border border-stone-300 border-t-stone-600 rounded-full animate-spin" />}
          <button onClick={onClose} className="text-stone-300 hover:text-stone-600"><X className="size-4" /></button>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-auto">
          {results.length === 0 && q.trim() && !loading && (
            <div className="px-4 py-12 text-center text-sm text-stone-400">没有匹配 "{q}" 的内容</div>
          )}
          {results.length === 0 && !q.trim() && (
            <div className="px-4 py-12 text-center text-xs text-stone-400">输入关键字搜索标题和正文</div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.page_id}:${r.line}:${i}`}
              onClick={() => void selectResult(r)}
              className={
                "px-4 py-2.5 cursor-pointer border-b border-stone-100 last:border-0 " +
                (i === selected ? "bg-emerald-50" : "hover:bg-stone-50")
              }
            >
              <div className="flex items-center gap-2 text-sm">
                <FileText className="size-3.5 text-stone-400 shrink-0" />
                <span className="font-medium text-stone-900">{r.title}</span>
                <span className="text-[10px] font-mono text-stone-400 truncate">{r.page_id}</span>
              </div>
              {r.snippet && r.line > 0 && (
                <div className="mt-1 text-xs text-stone-500 truncate pl-5.5 font-mono">
                  <span className="text-stone-400">L{r.line}:</span> {r.snippet}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-stone-100 flex items-center gap-3 text-[10px] text-stone-400">
          <span><kbd className="px-1 py-0.5 rounded border bg-stone-50 font-mono">↑↓</kbd> 选择</span>
          <span><kbd className="px-1 py-0.5 rounded border bg-stone-50 font-mono">⏎</kbd> 打开</span>
          <span><kbd className="px-1 py-0.5 rounded border bg-stone-50 font-mono">Esc</kbd> 关闭</span>
          {results.length > 0 && <span className="ml-auto">{results.length} 条结果</span>}
        </div>
      </div>
    </div>
  );
}
