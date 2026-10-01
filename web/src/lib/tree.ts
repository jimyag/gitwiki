import type { PageMeta } from "./api";
import { HOME } from "./route";

// pagePath returns the nodes from the top level down to id ("a", "a/b", "a/b/c"), or [] if
// the tree has no such page. Ids are slug paths, so each ancestor is found by its prefix.
export function pagePath(tree: PageMeta | null, id: string | null): PageMeta[] {
  if (!tree || !id) return [];
  const out: PageMeta[] = [];
  const parts = id.split("/");
  let level = tree.children ?? [];
  for (let i = 1; i <= parts.length; i++) {
    const want = parts.slice(0, i).join("/");
    const node = level.find(n => n.id === want);
    if (!node) return [];
    out.push(node);
    level = node.children ?? [];
  }
  return out;
}

// pageExists says whether id names an openable page (folders without a page file are not).
export function pageExists(tree: PageMeta, id: string): boolean {
  return id === HOME ? tree.has_body : !!pagePath(tree, id).at(-1)?.has_body;
}

export function parentOf(id: string): string {
  return id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
}

export interface FlatPage { id: string; title: string; depth: number; where: string; node: PageMeta }

// flattenTree lists every page depth-first; where is the titles of its ancestors.
export function flattenTree(tree: PageMeta | null): FlatPage[] {
  const out: FlatPage[] = [];
  const walk = (nodes: PageMeta[], depth: number, trail: string[]) => {
    for (const n of nodes) {
      out.push({ id: n.id, title: n.title, depth, where: trail.join(" / "), node: n });
      walk(n.children ?? [], depth + 1, [...trail, n.title]);
    }
  };
  walk(tree?.children ?? [], 0, []);
  return out;
}

// descendants counts the pages below node.
export function descendants(node: PageMeta): number {
  return (node.children ?? []).reduce((n, c) => n + 1 + descendants(c), 0);
}
