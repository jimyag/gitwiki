import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Folder, Home, Search } from "lucide-react";
import { useStore } from "../store";
import { flattenTree } from "../lib/tree";
import { HOME } from "../lib/route";
import { Dialog, dialogDesc, dialogTitle } from "./ui";

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

  return (
    <Dialog onClose={onClose} className="max-w-md">
      <div className="px-5 pt-5 pb-3">
        <h2 className={dialogTitle}>{title}</h2>
        {hint && <p className={dialogDesc}>{hint}</p>}
      </div>
      <div className="mx-4 mb-2 flex items-center gap-2 h-9 rounded-lg bg-surface px-3 ring-1 ring-inset ring-line-strong/80 transition-shadow focus-within:ring-2 focus-within:ring-accent/60">
        <Search className="size-3.5 shrink-0 text-fg-subtle" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
            if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
            if (e.key === "Enter" && enabled(sel)) onPick(items[sel]);
          }}
          placeholder="按标题筛选"
          className="flex-1 min-w-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div ref={listRef} className="max-h-[50vh] overflow-auto px-2 pb-2">
        {items.length === 0 && <div className="py-8 text-center text-sm text-fg-muted">没有匹配的页面</div>}
        {items.map((it, i) => {
          const Icon = it.kind === "home" || it.kind === "top" ? Home : it.kind === "folder" ? Folder : FileText;
          return (
            <button
              key={it.id || "top"}
              disabled={!enabled(i)}
              onClick={() => onPick(it)}
              onMouseMove={() => enabled(i) && setSel(i)}
              style={{ paddingLeft: q ? undefined : `${it.depth * 14 + 10}px` }}
              className={
                "w-full flex items-center gap-2 h-8 pr-2 pl-2.5 rounded-lg text-left text-[13px] transition-colors disabled:opacity-35 " +
                (i === sel ? "bg-shade text-fg" : "text-fg-2")
              }
            >
              <Icon className="size-3.5 shrink-0 text-fg-subtle" />
              <span className="truncate">{it.title}</span>
              {q && it.where && <span className="ml-auto pl-2 text-xs text-fg-subtle truncate">{it.where}</span>}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
