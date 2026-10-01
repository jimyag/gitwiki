// "最近看过" 和收藏都在本机 localStorage：跨设备不重要。
const RECENTS_KEY = "gitwiki.recentPages.v1";
const FAVS_KEY = "gitwiki.favoritePages.v1";

export interface Entry {
  repo: string;
  page: string;
  title: string;
  at: number;
}

function read(key: string): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, list: Entry[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 100)));
  } catch {}
}

export const getRecents = (repo: string) => read(RECENTS_KEY).filter(e => e.repo === repo);
export const getFavorites = (repo: string) => read(FAVS_KEY).filter(e => e.repo === repo);

export function pushRecent(repo: string, page: string, title: string) {
  if (page === "") return;
  const list = read(RECENTS_KEY).filter(e => !(e.repo === repo && e.page === page));
  list.unshift({ repo, page, title, at: Date.now() });
  write(RECENTS_KEY, list);
}

export function toggleFavorite(repo: string, page: string, title: string): boolean {
  const list = read(FAVS_KEY);
  const i = list.findIndex(e => e.repo === repo && e.page === page);
  if (i >= 0) {
    list.splice(i, 1);
    write(FAVS_KEY, list);
    return false;
  }
  list.unshift({ repo, page, title, at: Date.now() });
  write(FAVS_KEY, list);
  return true;
}

export function isFavorite(repo: string, page: string) {
  return read(FAVS_KEY).some(e => e.repo === repo && e.page === page);
}
