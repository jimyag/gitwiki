import { useState } from "react";
import { Archive, CalendarDays, FilePen, Hash, UserRound, X } from "lucide-react";
import type { Meta } from "../lib/api";
import { useStore } from "../store";
import { pagePath } from "../lib/tree";
import { HOME } from "../lib/route";
import { PagePicker } from "./PagePicker";

// One pill per property, so they line up as a single quiet row under the title.
const pill = "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[13px] ring-1 ring-inset ring-line transition-colors";
// The checkbox inside is visually hidden; the pill shows its state and its keyboard focus.
const toggle = (on: boolean, onCls: string) =>
  `${pill} cursor-pointer select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60 ${on ? onCls : "text-fg-muted hover:bg-shade hover:text-fg"}`;

// The page's Hugo front matter that the editor exposes: tags, draft, date, owner, deprecation
// and description. Every other field in the file is kept as it is.
export function PropertiesBar({ meta, onChange }: { meta: Meta; onChange(m: Meta): void }) {
  const [tag, setTag] = useState("");
  const [picking, setPicking] = useState(false);
  const pageId = useStore(s => s.currentPageId);
  const tree = useStore(s => s.tree);
  const replacement = meta.replaced_by === HOME ? "首页" : pagePath(tree, meta.replaced_by ?? null).at(-1)?.title;

  const addTag = () => {
    const t = tag.trim().replace(/^#/, "");
    if (t && !meta.tags.includes(t)) onChange({ ...meta, tags: [...meta.tags, t] });
    setTag("");
  };

  return (
    <div className="space-y-2.5 px-1">
      <div className="flex flex-wrap items-center gap-1.5 text-fg-muted">
        {meta.tags.map(t => (
          <span key={t} className="inline-flex items-center gap-0.5 h-7 pl-2.5 pr-1 rounded-full bg-shade text-[13px] text-fg-2">
            <span className="text-fg-subtle">#</span>{t}
            <button
              onClick={() => onChange({ ...meta, tags: meta.tags.filter(x => x !== t) })}
              title={`移除标签 ${t}`}
              className="ml-0.5 p-0.5 rounded-full text-fg-subtle hover:text-fg hover:bg-shade"
            ><X className="size-3" /></button>
          </span>
        ))}
        <label className={`${pill} text-fg-muted focus-within:ring-2 focus-within:ring-accent/60`}>
          <Hash className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); addTag(); }
              if (e.key === "Backspace" && !tag && meta.tags.length) onChange({ ...meta, tags: meta.tags.slice(0, -1) });
            }}
            onBlur={addTag}
            placeholder={meta.tags.length ? "继续添加" : "添加标签，回车确认"}
            className="field-sizing-content min-w-16 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
        </label>
        <span className="mx-1 h-4 w-px bg-line" />
        <label className={toggle(meta.draft, "bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-300")} title="草稿不会发布到站点">
          <input type="checkbox" checked={meta.draft} onChange={(e) => onChange({ ...meta, draft: e.target.checked })} className="sr-only" />
          <FilePen className="size-3.5" />草稿
        </label>
        <label className={`${pill} date-pill relative text-fg-muted focus-within:ring-2 focus-within:ring-accent/60`} title="文档日期">
          <CalendarDays className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            type="date"
            value={meta.date.slice(0, 10)}
            onChange={(e) => onChange({ ...meta, date: withDay(meta.date, e.target.value) })}
            className="bg-transparent text-fg-2 outline-none"
          />
        </label>
        <label className={`${pill} text-fg-muted focus-within:ring-2 focus-within:ring-accent/60`} title="负责人的 GitHub 用户名。页面长期没有更新时，会连同负责人列在“文档问题”里">
          <UserRound className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            value={meta.owner ?? ""}
            onChange={(e) => onChange({ ...meta, owner: e.target.value.replace(/[\s@]/g, "") })}
            placeholder="负责人"
            aria-label="负责人"
            className="field-sizing-content min-w-12 bg-transparent text-fg-2 outline-none placeholder:text-fg-subtle"
          />
        </label>
        <label className={toggle(!!meta.deprecated, "bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-300")}>
          <input type="checkbox" checked={!!meta.deprecated} onChange={e => onChange({ ...meta, deprecated: e.target.checked, replaced_by: e.target.checked ? meta.replaced_by : "" })} className="sr-only" />
          <Archive className="size-3.5" />已废弃
        </label>
        {meta.deprecated && (
          <span className="inline-flex items-center gap-1 text-[13px]">
            <button onClick={() => setPicking(true)} className="rounded-md px-1.5 py-0.5 text-amber-800 underline underline-offset-2 hover:bg-amber-500/10 dark:text-amber-300">
              {meta.replaced_by ? `替代页面：${replacement ?? "页面不存在"}` : "选择替代页面（可选）"}
            </button>
            {meta.replaced_by && (
              <button title="移除替代页面" onClick={() => onChange({ ...meta, replaced_by: "" })} className="rounded-full p-0.5 text-fg-subtle hover:bg-shade hover:text-fg">
                <X className="size-3.5" />
              </button>
            )}
          </span>
        )}
      </div>
      {picking && <PagePicker title="选择替代页面" disabled={id => id === pageId} onClose={() => setPicking(false)} onPick={p => { onChange({ ...meta, replaced_by: p.id }); setPicking(false); }} />}
      <input
        value={meta.description}
        onChange={(e) => onChange({ ...meta, description: e.target.value })}
        placeholder="一句话描述（站点摘要和搜索引擎会用到）"
        aria-label="页面描述"
        className="w-full h-8 border-b border-transparent bg-transparent text-[15px] text-fg-muted outline-none transition-colors placeholder:text-fg-subtle focus:border-line-strong"
      />
    </div>
  );
}

// withDay sets the calendar day of a Hugo date and keeps its time of day, if it had one.
function withDay(date: string, day: string): string {
  if (!day) return "";
  const time = /^\d{4}-\d{2}-\d{2}(T.*)$/.exec(date)?.[1];
  return time ? day + time : day;
}
