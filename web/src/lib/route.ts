// The address bar mirrors what is open: /<repo>/<page id>#<heading id>, and /<repo> for the home
// page. Page ids are paths in the content directory (getting-started/install), so the URL follows
// the wiki's tree and stays valid when a page is retitled.

// The home page, content/_index.md.
export const HOME = "_index";

export function parseLocation(): { repo: string | null; page: string } {
  const [repo, ...rest] = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return { repo: repo ?? null, page: rest.length ? rest.join("/") : HOME };
}

export function pathFor(repo: string | null, page: string | null): string {
  if (!repo) return "/";
  const parts = page && page !== HOME ? page.split("/") : [];
  return "/" + [repo, ...parts].map(encodeURIComponent).join("/");
}

// Pages link to each other by the path Hugo publishes them under: "/getting-started/install",
// "/" for the home page. linkFor writes such a link, pageLink reads one back (null for other
// sites, relative paths and "//host" URLs).
export function linkFor(id: string): string {
  return id === HOME ? "/" : `/${id}`;
}

export function pageLink(href: string): { id: string; hash: string } | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const [path, hash] = href.split("#", 2);
  try {
    const id = decodeURI(path.split("?")[0]).replace(/^\/+|\/+$/g, "");
    return { id: id || HOME, hash: hash ? `#${hash}` : "" };
  } catch {
    return null;
  }
}

// setHash records the section being read without adding a history entry or scrolling.
export function setHash(id: string | null) {
  history.replaceState(history.state, "", id ? `#${encodeURIComponent(id)}` : location.pathname);
}

export function currentHash(): string | null {
  return location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
}
