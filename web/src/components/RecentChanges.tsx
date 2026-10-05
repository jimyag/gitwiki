import { useEffect, useState } from "react";
import { Clock, RotateCcw, Star } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api, type Change } from "../lib/api";
import { changeLabel, formatRelativeTime } from "../lib/format";
import { pathFor } from "../lib/route";
import { getFavorites, getRecents, type Entry } from "../lib/recents";
import { Avatar, btnOutline } from "./ui";

const heading = "flex items-center gap-2 mb-3 text-sm font-semibold text-stone-900";

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

  return (
    <div className="mt-16 space-y-10">
      <RecentsAndFavs />
      {!!changes?.length && (
        <section>
          <h2 className={heading}><Clock className="size-4 text-stone-400" />最近更新</h2>
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
            {changes.map(c => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar login={c.author} className="size-7 text-[11px]" />
                <div className="min-w-0 flex-1">
                  {c.deleted ? (
                    <span className="text-sm text-stone-400 line-through decoration-stone-300">{c.title}</span>
                  ) : (
                    <a
                      href={pathFor(repo!, c.id)}
                      onClick={(e) => { e.preventDefault(); useStore.getState().openPage(c.id); }}
                      className="text-sm font-medium text-stone-800 hover:text-emerald-700 transition"
                    >{c.title}</a>
                  )}
                  <div className="text-xs text-stone-400 truncate">{c.author} {changeLabel(c.message)}</div>
                </div>
                <span className="shrink-0 text-xs text-stone-400" title={new Date(c.date).toLocaleString()}>{formatRelativeTime(c.date)}</span>
                {c.deleted && canWrite && (
                  <button onClick={() => void restore(c)} className={`${btnOutline} shrink-0`}>
                    <RotateCcw className="size-3.5" />恢复
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// 本地记录的两张清单：收藏，最近看过。只在本机，跨设备不同步。
function RecentsAndFavs() {
  const repo = useStore(s => s.currentRepo);
  const currentPageId = useStore(s => s.currentPageId);
  const [favs, setFavs] = useState<Entry[]>([]);
  const [recents, setRecents] = useState<Entry[]>([]);

  useEffect(() => {
    if (!repo) return;
    setFavs(getFavorites(repo));
    setRecents(getRecents(repo).slice(0, 8));
  }, [repo, currentPageId]);

  if (!repo || (!favs.length && !recents.length)) return null;
  const List = ({ list }: { list: Entry[] }) => (
    <ul className="flex flex-wrap gap-1.5">
      {list.map(e => (
        <li key={e.page}>
          <a
            href={pathFor(repo, e.page)}
            onClick={(ev) => { ev.preventDefault(); useStore.getState().openPage(e.page); }}
            className="inline-flex items-center h-7 px-2.5 rounded-md border border-stone-200 bg-white text-[13px] text-stone-700 hover:border-stone-300 hover:bg-stone-50 transition truncate max-w-56"
          >{e.title}</a>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="space-y-6">
      {!!favs.length && (
        <div>
          <h2 className={heading}><Star className="size-4 text-amber-500" />收藏</h2>
          <List list={favs} />
        </div>
      )}
      {!!recents.length && (
        <div>
          <h2 className={heading}><Clock className="size-4 text-stone-400" />最近看过</h2>
          <List list={recents} />
        </div>
      )}
    </section>
  );
}
