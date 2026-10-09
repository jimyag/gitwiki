import { useMemo, useState } from "react";
import { FileText, Pencil, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api } from "../lib/api";
import { flattenTree, type FlatPage } from "../lib/tree";
import { Dialog, DialogHeader, btnGhost, btnPrimary, btnSecondary } from "./ui";

const field = "h-8 min-w-0 rounded-lg bg-surface px-2.5 text-[13px] text-fg ring-1 ring-inset ring-line-strong/80 outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent/60";

// Browse pages by their front matter tags (the same tags Hugo builds taxonomy pages from).
// Writers can also rename or remove a tag on every page, and add or remove one on the pages
// they tick; each change is one commit.
export function TagsModal({ initial, onClose }: { initial: string; onClose(): void }) {
  const tree = useStore(s => s.tree);
  const repo = useStore(s => s.currentRepo);
  const canWrite = useCanWrite();
  const tags = useMemo(() => {
    const byTag = new Map<string, FlatPage[]>();
    for (const p of flattenTree(tree)) {
      for (const t of p.node.tags ?? []) byTag.set(t, [...(byTag.get(t) ?? []), p]);
    }
    return [...byTag].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"));
  }, [tree]);
  const [sel, setSel] = useState(initial);
  const selected = tags.find(([t]) => t === sel) ?? tags[0];
  const [renaming, setRenaming] = useState<string | null>(null); // the new name, while renaming
  const [picked, setPicked] = useState<string[]>([]); // pages ticked for a change
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);

  const choose = (t: string) => {
    setSel(t);
    setRenaming(null);
    setPicked([]);
  };

  // The tree reloads afterwards, and this list with it; so does the open page if it changed.
  const retag = async (from: string, to: string, pages: string[] | undefined, done: string) => {
    if (!repo || busy) return false;
    setBusy(true);
    try {
      const res = await api.retag(repo, from, to, pages);
      await useStore.getState().refreshTree();
      const st = useStore.getState();
      if (st.currentPageId && res.pages.includes(st.currentPageId) && !st.dirty) st.reloadPage();
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(`修改标签失败：${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!selected || renaming === null) return;
    const [tag, pages] = selected;
    const name = renaming.trim().replace(/^#/, "");
    if (!name || name === tag) { setRenaming(null); return; }
    if (tags.some(([t]) => t === name) && !confirm(`标签「${name}」已经存在，把「${tag}」合并进去？`)) return;
    if (await retag(tag, name, undefined, `已把 ${pages.length} 个页面的「${tag}」改为「${name}」`)) choose(name);
  };

  const remove = async () => {
    if (!selected) return;
    const [tag, pages] = selected;
    if (!confirm(`从 ${pages.length} 个页面移除标签「${tag}」？页面本身不受影响。`)) return;
    if (await retag(tag, "", undefined, `已从 ${pages.length} 个页面移除「${tag}」`)) choose("");
  };

  const addToPicked = async () => {
    const name = adding.trim().replace(/^#/, "");
    if (!name) return;
    if (await retag("", name, picked, `已给 ${picked.length} 个页面加上「${name}」`)) {
      setAdding("");
      setPicked([]);
    }
  };

  const removeFromPicked = async () => {
    if (!selected) return;
    if (await retag(selected[0], "", picked, `已从 ${picked.length} 个页面移除「${selected[0]}」`)) setPicked([]);
  };

  return (
    <Dialog onClose={onClose} className="max-w-[620px]">
      <DialogHeader icon={Tag} title="标签" meta={`${tags.length} 个`} onClose={onClose} />
      {tags.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-fg-muted">还没有页面设置标签。编辑页面时可以在标题下面添加。</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 p-4 border-b border-line">
            {tags.map(([t, pages]) => (
              <button
                key={t}
                onClick={() => choose(t)}
                className={
                  "inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[13px] transition-colors " +
                  (t === selected?.[0] ? "bg-ink text-ink-fg" : "bg-shade text-fg-2 hover:text-fg")
                }
              >
                <span className="opacity-50">#</span>{t}
                <span className="ml-0.5 tabular-nums opacity-60">{pages.length}</span>
              </button>
            ))}
          </div>
          {canWrite && selected && (
            <div className="flex items-center gap-2 min-h-12 px-4 py-2 border-b border-line">
              {renaming === null ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
                    <span className="font-medium text-fg">#{selected[0]}</span> · {selected[1].length} 个页面
                  </span>
                  <button className={btnGhost} disabled={busy} onClick={() => setRenaming(selected[0])}>
                    <Pencil className="size-3.5" />重命名
                  </button>
                  <button className={btnGhost} disabled={busy} onClick={() => void remove()}>
                    <Trash2 className="size-3.5" />删除标签
                  </button>
                </>
              ) : (
                <>
                  <input
                    autoFocus
                    aria-label="新的标签名"
                    value={renaming}
                    onChange={e => setRenaming(e.target.value)}
                    onKeyDown={e => {
                      e.stopPropagation(); // Escape cancels the rename, not the dialog
                      if (e.key === "Enter") void rename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className={`${field} flex-1`}
                  />
                  <button className={btnGhost} onClick={() => setRenaming(null)}>取消</button>
                  <button className={btnPrimary} disabled={busy} onClick={() => void rename()}>确定</button>
                </>
              )}
            </div>
          )}
          <ul className="max-h-[45vh] overflow-auto p-1.5">
            {selected?.[1].map(p => (
              <li key={p.id} className="flex items-center gap-1 rounded-lg transition-colors hover:bg-shade">
                {canWrite && (
                  <label className="flex shrink-0 items-center self-stretch pl-3 pr-1 cursor-pointer" title="选中后可以批量修改标签">
                    <input
                      type="checkbox"
                      aria-label={`选择「${p.title}」`}
                      checked={picked.includes(p.id)}
                      onChange={e => setPicked(list => e.target.checked ? [...list, p.id] : list.filter(id => id !== p.id))}
                      className="size-4 accent-accent"
                    />
                  </label>
                )}
                <button
                  onClick={() => { if (useStore.getState().openPage(p.id)) onClose(); }}
                  className={"min-w-0 flex-1 flex items-center gap-2.5 py-2 pr-3 text-left text-sm " + (canWrite ? "pl-1.5" : "pl-3")}
                >
                  <FileText className="size-4 shrink-0 text-fg-subtle" />
                  <span className="font-medium text-fg truncate">{p.title}</span>
                  {p.where && <span className="ml-auto pl-2 text-xs text-fg-subtle truncate">{p.where}</span>}
                </button>
              </li>
            ))}
          </ul>
          {picked.length > 0 && selected && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line bg-subtle">
              <span className="text-[13px] text-fg-muted">已选 {picked.length} 个页面</span>
              <span className="ml-auto flex items-center gap-1.5">
                <input
                  aria-label="要添加的标签"
                  placeholder="添加标签"
                  value={adding}
                  onChange={e => setAdding(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") void addToPicked(); }}
                  className={`${field} w-28`}
                />
                <button className={btnSecondary} disabled={busy || !adding.trim()} onClick={() => void addToPicked()}>添加</button>
              </span>
              <button className={btnSecondary} disabled={busy} onClick={() => void removeFromPicked()}>移除「{selected[0]}」</button>
              <button className={btnGhost} onClick={() => setPicked([])}>取消选择</button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
