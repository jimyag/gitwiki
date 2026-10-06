import { useState } from "react";
import { CalendarDays, Tag, X } from "lucide-react";
import type { Meta } from "../lib/api";

// The page's Hugo front matter that the editor exposes: tags, draft, date and description.
// Every other field in the file is kept as it is.
export function PropertiesBar({ meta, onChange }: { meta: Meta; onChange(m: Meta): void }) {
  const [tag, setTag] = useState("");

  const addTag = () => {
    const t = tag.trim().replace(/^#/, "");
    if (t && !meta.tags.includes(t)) onChange({ ...meta, tags: [...meta.tags, t] });
    setTag("");
  };

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[13px] text-stone-500">
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        <Tag className="size-3.5 shrink-0 text-stone-400" />
        {meta.tags.map(t => (
          <span key={t} className="inline-flex items-center gap-0.5 h-6 pl-2 pr-1 rounded-full bg-stone-100 text-stone-700">
            {t}
            <button
              onClick={() => onChange({ ...meta, tags: meta.tags.filter(x => x !== t) })}
              title={`移除标签 ${t}`}
              className="p-0.5 rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-200"
            ><X className="size-3" /></button>
          </span>
        ))}
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); addTag(); }
            if (e.key === "Backspace" && !tag && meta.tags.length) onChange({ ...meta, tags: meta.tags.slice(0, -1) });
          }}
          onBlur={addTag}
          placeholder={meta.tags.length ? "继续添加" : "添加标签，回车确认"}
          className="w-32 h-6 bg-transparent outline-none placeholder:text-stone-400"
        />
      </div>
      <label className="inline-flex items-center gap-1.5 cursor-pointer select-none" title="草稿不会发布到站点">
        <input
          type="checkbox"
          checked={meta.draft}
          onChange={(e) => onChange({ ...meta, draft: e.target.checked })}
          className="accent-emerald-600"
        />
        草稿
      </label>
      <label className="inline-flex items-center gap-1.5" title="文档日期">
        <CalendarDays className="size-3.5 text-stone-400" />
        <input
          type="date"
          value={meta.date.slice(0, 10)}
          onChange={(e) => onChange({ ...meta, date: withDay(meta.date, e.target.value) })}
          className="h-6 bg-transparent outline-none text-stone-600"
        />
      </label>
      <input
        value={meta.description}
        onChange={(e) => onChange({ ...meta, description: e.target.value })}
        placeholder="一句话描述（站点摘要和搜索引擎会用到）"
        className="flex-1 min-w-[14rem] h-6 bg-transparent outline-none border-b border-transparent focus:border-stone-300 placeholder:text-stone-400"
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
