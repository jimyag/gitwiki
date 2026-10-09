import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api, type SearchHit } from "../lib/api";
import { flattenTree, pagePath } from "../lib/tree";
import { getRecents } from "../lib/recents";
import { FileText, Loader2, Search } from "lucide-react";
import { Dialog, Kbd } from "./ui";

// The ⌘K palette: recently viewed pages until something is typed or filtered, then search hits.
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
  const recents = useMemo<SearchHit[]>(() => {
    const open = useStore.getState().currentPageId;
    return currentRepo
      ? getRecents(currentRepo).filter(e => e.page !== open).slice(0, 8).map(e => ({ page_id: e.page, title: e.title, snippet: "", terms: [] }))
      : [];
  }, [currentRepo]);
  const items = searching ? results : recents;

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

  // The page opens with the matched terms marked (see Editor).
  const selectResult = (r: SearchHit) => {
    if (!openPage(r.page_id)) return;
    useStore.getState().setSearchHighlight(r.terms);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.max(0, Math.min(s + 1, items.length - 1))); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    if (e.key === "Enter" && items[selected]) selectResult(items[selected]);
  };

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <Dialog onClose={onClose} className="max-w-[640px]">
      <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
        <Search className="size-[18px] text-fg-subtle shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索标题和正文，多个词用空格分开"
          aria-label="搜索标题和正文"
          className="flex-1 min-w-0 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
        />
        {loading && <Loader2 className="size-4 shrink-0 animate-spin text-fg-subtle" />}
        <button onClick={onClose} title="关闭" className="shrink-0 rounded-md transition-opacity hover:opacity-70"><Kbd>Esc</Kbd></button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-line">
        <Filter label="目录" value={directory} onChange={setDirectory}>
          <option value="">全部</option>
          {pages.filter(p => p.node.is_dir || p.node.children?.length).map(p => <option key={p.id} value={p.id}>{[p.where, p.title].filter(Boolean).join(" / ")}</option>)}
        </Filter>
        <Filter label="标签" value={tag} onChange={setTag}>
          <option value="">全部</option>
          {tags.map(t => <option key={t} value={t}>{t}</option>)}
        </Filter>
        <Filter label="最后更新" value={days} onChange={setDays}>
          <option value="">不限</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </Filter>
        <Filter label="状态" value={draft} onChange={setDraft}>
          <option value="">全部</option>
          <option value="true">草稿</option>
          <option value="false">非草稿</option>
        </Filter>
        {filtered && (
          <button onClick={() => { setDirectory(""); setTag(""); setDays(""); setDraft(""); }} className="h-7 px-2 rounded-lg text-xs text-fg-muted transition-colors hover:bg-shade hover:text-fg">
            清除筛选
          </button>
        )}
      </div>
      <div aria-busy={loading} className="max-h-[min(52vh,30rem)] overflow-auto p-1.5">
        {error && <div role="alert" className="px-4 py-10 text-center text-sm text-red-600 dark:text-red-400">{error}</div>}
        {items.length === 0 && searching && !loading && !error && (
          <div className="px-4 py-12 text-center text-sm text-fg-muted">没有符合搜索条件的页面</div>
        )}
        {!searching && !recents.length && (
          <div className="px-4 py-12 text-center text-sm text-fg-muted">输入关键词或选择筛选条件；标题匹配优先</div>
        )}
        {!searching && !!recents.length && <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">最近看过</div>}
        <div ref={listRef}>
          {items.map((r, i) => {
            // Where the page sits, by title; slugs are random so they tell the reader nothing.
            const where = pagePath(tree, r.page_id).slice(0, -1).map(n => n.title).join(" / ");
            return (
              <button
                key={r.page_id}
                onClick={() => selectResult(r)}
                onMouseMove={() => setSelected(i)}
                className={"w-full text-left px-3 py-2.5 rounded-lg cursor-pointer " + (i === selected ? "bg-shade" : "")}
              >
                <div className="flex items-center gap-2.5 text-sm min-w-0">
                  <FileText className="size-4 text-fg-subtle shrink-0" />
                  <span className="font-medium text-fg truncate"><Highlight text={r.title} terms={r.terms} /></span>
                  {r.deprecated && <span className="shrink-0 rounded-md bg-amber-500/10 px-1.5 text-xs text-amber-800 dark:text-amber-300">已废弃</span>}
                  {where && <span className="ml-auto pl-2 text-xs text-fg-subtle truncate shrink-0 max-w-[40%]">{where}</span>}
                </div>
                {r.snippet && (
                  <div className="mt-1 pl-[26px] text-[13px] leading-relaxed text-fg-muted line-clamp-2">
                    <Highlight text={r.snippet} terms={r.terms} />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="px-4 h-10 border-t border-line flex items-center gap-4 text-xs text-fg-muted">
        <span className="hidden sm:flex items-center gap-1.5"><Kbd>↑↓</Kbd>选择</span>
        <span className="hidden sm:flex items-center gap-1.5"><Kbd>↵</Kbd>打开</span>
        <span className="hidden sm:flex items-center gap-1.5"><Kbd>Esc</Kbd>关闭</span>
        {searching && results.length > 0 && <span className="ml-auto">{results.length === 50 ? "最多显示 50 个页面，可继续筛选" : `${results.length} 个页面`}</span>}
      </div>
    </Dialog>
  );
}

// A filter as a pill: its name, then the native select showing the choice.
function Filter({ label, value, onChange, children }: { label: string; value: string; onChange(v: string): void; children: ReactNode }) {
  return (
    <label className={
      "inline-flex items-center h-7 rounded-full text-xs ring-1 ring-inset transition-colors focus-within:ring-2 focus-within:ring-accent/60 " +
      (value ? "bg-accent-soft text-accent-strong ring-accent/30" : "text-fg-muted ring-line hover:bg-shade")
    }>
      <span className={"pl-3 " + (value ? "" : "text-fg-subtle")}>{label}</span>
      {/* field-sizing: as wide as the choice shown, not the longest option */}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label={label}
        className="field-sizing-content h-full max-w-[11rem] truncate bg-transparent bg-[position:right_0.5rem_center] pl-1.5 pr-7 font-medium outline-none cursor-pointer"
      >
        {children}
      </select>
    </label>
  );
}

// Highlight marks every occurrence of the matched terms, ignoring case.
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? <mark key={i} className="rounded-sm bg-amber-200/70 text-fg dark:bg-amber-400/25">{part}</mark> : part,
      )}
    </>
  );
}
