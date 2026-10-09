import { useEffect, useState } from "react";
import { Activity, FileText, History, RotateCcw, Star } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api, type Change } from "../lib/api";
import { changeLabel, formatRelativeTime } from "../lib/format";
import { HOME, pathFor } from "../lib/route";
import { pagePath } from "../lib/tree";
import { getFavorites, getRecents, type Entry } from "../lib/recents";
import { Avatar, btnSecondary } from "./ui";

const heading = "flex items-center gap-2 mb-3 text-sm font-semibold text-fg";

// dayLabel groups the change list: 今天, 昨天, then by week.
function dayLabel(date: string): string {
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(new Date(date))) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return days < 7 ? "最近 7 天" : "更早";
}

// The home page's "最近更新": the latest change of each page, deleted pages included, which
// can be restored from here (git keeps them).
export function RecentChanges() {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree); // replaced after every change in the wiki: time to reload
  const canWrite = useCanWrite();
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    if (!repo) return;
    let live = true;
    api.recent(repo).then(c => live && setChanges(c), () => live && setChanges([]));
    return () => { live = false; };
  }, [repo, tree]);

  const restore = async (c: Change) => {
    if (!repo) return;
    try {
      await api.restorePage(repo, c.id, c.sha);
      await useStore.getState().refreshTree();
      toast.success(`已恢复「${c.title}」`);
    } catch (e) {
      toast.error(`恢复失败：${(e as Error).message}`);
    }
  };

  // The list is newest first, so each day's changes are already together.
  const groups: [string, Change[]][] = [];
  for (const c of changes ?? []) {
    const label = dayLabel(c.date);
    if (groups.at(-1)?.[0] === label) groups.at(-1)![1].push(c);
    else groups.push([label, [c]]);
  }

  return (
    <div className="mt-16 space-y-12">
      <RecentsAndFavs />
      {groups.length > 0 && (
        <section>
          <h2 className={heading}><Activity className="size-4 text-fg-subtle" />最近更新</h2>
          <div className="space-y-5">
            {groups.map(([label, list]) => (
              <div key={label}>
                <div className="mb-2 px-1 text-xs font-medium text-fg-subtle">{label}</div>
                <ul className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
                  {list.map(c => (
                    <li key={c.id} className="flex items-center gap-3 px-3.5 py-2.5">
                      <Avatar login={c.author} className="size-6 text-[10px]" />
                      <div className="min-w-0 flex-1">
                        {c.deleted ? (
                          <span className="text-sm text-fg-subtle line-through decoration-line-strong">{c.title}</span>
                        ) : (
                          <a
                            href={pathFor(repo!, c.id)}
                            onClick={(e) => { e.preventDefault(); useStore.getState().openPage(c.id); }}
                            className="text-sm font-medium text-fg transition-colors hover:text-accent-strong"
                          >{c.title}</a>
                        )}
                        <div className="text-xs text-fg-muted truncate">{c.author} {changeLabel(c.message)}</div>
                      </div>
                      <span className="shrink-0 text-xs text-fg-subtle" title={new Date(c.date).toLocaleString()}>{formatRelativeTime(c.date)}</span>
                      {c.deleted && canWrite && (
                        <button onClick={() => void restore(c)} className={`${btnSecondary} shrink-0`}>
                          <RotateCcw className="size-3.5" />恢复
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// 本地记录的两张清单：收藏，最近看过。只在本机，跨设备不同步。
function RecentsAndFavs() {
  const repo = useStore(s => s.currentRepo);
  const currentPageId = useStore(s => s.currentPageId);
  const tree = useStore(s => s.tree);
  const [favs, setFavs] = useState<Entry[]>([]);
  const [recents, setRecents] = useState<Entry[]>([]);

  useEffect(() => {
    if (!repo) return;
    setFavs(getFavorites(repo));
    setRecents(getRecents(repo).filter(e => e.page !== HOME).slice(0, 6));
  }, [repo, currentPageId]);

  if (!repo || (!favs.length && !recents.length)) return null;
  const Cards = ({ list }: { list: Entry[] }) => (
    <ul className="grid gap-2 sm:grid-cols-2">
      {list.map(e => {
        // Where the page sits, by title: page ids are random slugs.
        const where = pagePath(tree, e.page).slice(0, -1).map(n => n.title).join(" / ");
        return (
          <li key={e.page}>
            <a
              href={pathFor(repo, e.page)}
              onClick={(ev) => { ev.preventDefault(); useStore.getState().openPage(e.page); }}
              className="group flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line transition hover:bg-subtle hover:ring-line-strong"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-shade text-fg-subtle transition-colors group-hover:text-fg-muted">
                <FileText className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">{e.title}</span>
                <span className="block truncate text-xs text-fg-muted">{where || "顶层页面"}</span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
  return (
    <section className="space-y-10">
      {!!favs.length && (
        <div>
          <h2 className={heading}><Star className="size-4 text-amber-500" />收藏</h2>
          <Cards list={favs} />
        </div>
      )}
      {!!recents.length && (
        <div>
          <h2 className={heading}><History className="size-4 text-fg-subtle" />最近看过</h2>
          <Cards list={recents} />
        </div>
      )}
    </section>
  );
}
