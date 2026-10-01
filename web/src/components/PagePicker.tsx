import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Folder, Home, Search } from "lucide-react";
import { useStore } from "../store";
import { flattenTree } from "../lib/tree";
import { HOME } from "../lib/route";
import { overlay } from "./ui";

export interface PickedPage { id: string; title: string }

interface Item { id: string; title: string; depth: number; where: string; kind: "top" | "home" | "page" | "folder" }

// A searchable list of the wiki's pages: picks a link target, or a new parent when moving.
export function PagePicker({ title, hint, top, disabled, onPick, onClose }: {
  title: string;
  hint?: string;
  top?: string; // label for an extra first entry meaning the top level (picked as id "")
  disabled?: (id: string) => boolean;
  onPick(p: PickedPage): void;
  onClose(): void;
}) {
  const tree = useStore(s => s.tree);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const out: Item[] = [];
    if (top !== undefined) out.push({ id: "", title: top, depth: 0, where: "", kind: "top" });
    else if (tree?.has_body) out.push({ id: HOME, title: "首页", depth: 0, where: "", kind: "home" });
    for (const p of flattenTree(tree)) {
      out.push({ id: p.id, title: p.title, depth: p.depth, where: p.where, kind: p.node.has_body ? "page" : "folder" });
    }
    const needle = q.trim().toLowerCase();
    return needle ? out.filter(it => it.title.toLowerCase().includes(needle)) : out;
  }, [tree, top, q]);

  const enabled = (i: number) => i >= 0 && i < items.length && !disabled?.(items[i].id) && (top !== undefined || items[i].kind !== "folder");
  // Start on the first entry that can be picked; filtering moves the selection back up.
  useEffect(() => {
    setSel(items.findIndex((_, i) => enabled(i)));
  }, [items]);

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const step = (dir: 1 | -1) => {
    for (let i = sel + dir; i >= 0 && i < items.length; i += dir) {
      if (enabled(i)) return setSel(i);
    }
  };

  return createPortal(
    <div className={`${overlay} flex items-start justify-center pt-[12vh] px-4`} onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-4 pb-3">
          <h3 className="font-semibold text-sm text-stone-900">{title}</h3>
          {hint && <p className="text-xs text-stone-500 mt-0.5">{hint}</p>}
        </div>
        <div className="mx-4 mb-2 flex items-center gap-2 h-9 rounded-md border border-stone-200 px-2.5 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 transition">
          <Search className="size-3.5 shrink-0 text-stone-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
              if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
              if (e.key === "Enter" && enabled(sel)) onPick(items[sel]);
              if (e.key === "Escape") onClose();
            }}
            placeholder="按标题筛选"
            className="flex-1 min-w-0 text-sm outline-none placeholder:text-stone-400"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-auto px-2 pb-2">
          {items.length === 0 && <div className="py-8 text-center text-sm text-stone-400">没有匹配的页面</div>}
          {items.map((it, i) => {
            const Icon = it.kind === "home" || it.kind === "top" ? Home : it.kind === "folder" ? Folder : FileText;
            return (
              <button
                key={it.id || "top"}
                disabled={!enabled(i)}
                onClick={() => onPick(it)}
                onMouseMove={() => enabled(i) && setSel(i)}
                style={{ paddingLeft: q ? undefined : `${it.depth * 14 + 8}px` }}
                className={
                  "w-full flex items-center gap-2 h-8 pr-2 pl-2 rounded-md text-left text-[13px] transition-colors disabled:opacity-35 " +
                  (i === sel ? "bg-stone-100 text-stone-900" : "text-stone-700")
                }
              >
                <Icon className="size-3.5 shrink-0 text-stone-400" />
                <span className="truncate">{it.title}</span>
                {q && it.where && <span className="ml-auto pl-2 text-xs text-stone-400 truncate">{it.where}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
