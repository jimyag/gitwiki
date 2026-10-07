import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { api, type SearchHit } from "../lib/api";
import { flattenTree, pagePath } from "../lib/tree";
import { Search, FileText, X } from "lucide-react";
import { Dialog } from "./ui";

export function SearchModal({ onClose }: { onClose: () => void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const openPage = useStore(s => s.openPage);
  const tree = useStore(s => s.tree);
  const [q, setQ] = useState("");
  const [directory, setDirectory] = useState("");
  const [tag, setTag] = useState("");
  const [days, setDays] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const pages = useMemo(() => flattenTree(tree), [tree]);
  const tags = useMemo(() => [...new Set([...(tree?.tags ?? []), ...pages.flatMap(p => p.node.tags ?? [])])].sort((a, b) => a.localeCompare(b, "zh")), [pages, tree]);
  const filtered = !!(directory || tag || days || draft);
  const searching = !!q.trim() || filtered;
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    setResults([]);
    setSelected(0);
    setError("");
    if (!currentRepo || !searching) { setLoading(false); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(async () => {
      try {
        const hits = await api.search(currentRepo, q.trim(), {
          directory, tag, draft,
          updated_after: days ? new Date(Date.now() - Number(days) * 86400000).toISOString() : "",
        });
        if (live) { setResults(hits); setSelected(0); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "搜索失败，请重试");
      } finally {
        if (live) setLoading(false);
      }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, currentRepo, directory, tag, days, draft, searching]);

  const selectResult = (r: SearchHit) => {
    if (openPage(r.page_id)) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.max(0, Math.min(s + 1, results.length - 1))); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && results[selected]) selectResult(results[selected]);
  };

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <Dialog onClose={onClose} className="max-w-[600px]">
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-stone-200">
        <Search className="size-4 text-stone-400 shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索标题和正文，多个词用空格分开"
          aria-label="搜索标题和正文"
          className="flex-1 min-w-0 text-[15px] outline-none placeholder:text-stone-400"
        />
        {loading && <div className="size-3.5 border-2 border-stone-200 border-t-stone-500 rounded-full animate-spin" />}
        <button onClick={onClose} title="关闭" className="p-1 rounded text-stone-300 hover:text-stone-600"><X className="size-4" /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 py-3 border-b border-stone-100 text-xs">
        <label className="min-w-0 text-stone-500">目录
          <select value={directory} onChange={e => setDirectory(e.target.value)} className="mt-1 w-full rounded border border-stone-200 bg-white p-1.5 text-stone-700">
            <option value="">全部目录</option>
            {pages.filter(p => p.node.is_dir || p.node.children?.length).map(p => <option key={p.id} value={p.id}>{[p.where, p.title].filter(Boolean).join(" / ")}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-stone-500">标签
          <select value={tag} onChange={e => setTag(e.target.value)} className="mt-1 w-full rounded border border-stone-200 bg-white p-1.5 text-stone-700">
            <option value="">全部标签</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-stone-500">最后更新
          <select value={days} onChange={e => setDays(e.target.value)} className="mt-1 w-full rounded border border-stone-200 bg-white p-1.5 text-stone-700">
            <option value="">不限时间</option>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
          </select>
        </label>
        <label className="min-w-0 text-stone-500">状态
          <select value={draft} onChange={e => setDraft(e.target.value)} className="mt-1 w-full rounded border border-stone-200 bg-white p-1.5 text-stone-700">
            <option value="">全部状态</option>
            <option value="true">草稿</option>
            <option value="false">非草稿</option>
          </select>
        </label>
        {filtered && <button onClick={() => { setDirectory(""); setTag(""); setDays(""); setDraft(""); }} className="justify-self-start text-stone-500 hover:text-stone-900 underline">清除筛选</button>}
      </div>
      <div ref={listRef} aria-busy={loading} className="max-h-[45vh] overflow-auto p-1.5">
        {error && <div role="alert" className="px-4 py-8 text-center text-sm text-red-600">{error}</div>}
        {results.length === 0 && searching && !loading && !error && (
          <div className="px-4 py-12 text-center text-sm text-stone-400">没有符合搜索条件的页面</div>
        )}
        {!searching && (
          <div className="px-4 py-12 text-center text-sm text-stone-400">输入关键词或选择筛选条件；标题匹配优先</div>
        )}
        {results.map((r, i) => {
          // Where the page sits, by title; slugs are random so they tell the reader nothing.
          const where = pagePath(tree, r.page_id).slice(0, -1).map(n => n.title).join(" / ");
          return (
            <button
              key={r.page_id}
              onClick={() => selectResult(r)}
              onMouseMove={() => setSelected(i)}
              className={"w-full text-left px-3 py-2 rounded-lg cursor-pointer " + (i === selected ? "bg-stone-100" : "")}
            >
              <div className="flex items-center gap-2 text-sm min-w-0">
                <FileText className="size-3.5 text-stone-400 shrink-0" />
                <span className="font-medium text-stone-900 truncate"><Highlight text={r.title} terms={r.terms} /></span>
                {r.deprecated && <span className="shrink-0 rounded bg-amber-50 px-1.5 text-xs text-amber-800">已废弃</span>}
                {where && <span className="ml-auto pl-2 text-xs text-stone-400 truncate shrink-0 max-w-[40%]">{where}</span>}
              </div>
              {r.snippet && (
                <div className="mt-1 pl-[22px] text-[13px] leading-relaxed text-stone-500 line-clamp-2">
                  <Highlight text={r.snippet} terms={r.terms} />
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="px-4 py-2 border-t border-stone-100 flex items-center gap-3 text-[11px] text-stone-400">
        <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">↑↓</kbd> 选择</span>
        <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">⏎</kbd> 打开</span>
        <span><kbd className="px-1 rounded border border-stone-200 bg-stone-50 font-mono">Esc</kbd> 关闭</span>
        {results.length > 0 && <span className="ml-auto">{results.length === 50 ? "最多显示 50 个页面，可继续筛选" : `${results.length} 个页面`}</span>}
      </div>
    </Dialog>
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
