import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import remarkMath from "remark-math";
import rehypeSlug from "rehype-slug";
import type { Root, RootContent } from "hast";
import type { HealthPage, HealthSnapshot } from "./api";
import { remarkAlerts, remarkShortcodes } from "./markdown";
import { HOME } from "./route";

// A stale page has no line: target names its owner, excerpt when it was last updated.
export interface HealthIssue {
  page: string; title: string; line: number; target: string;
  kind: "page" | "asset" | "anchor" | "replacement" | "stale";
  excerpt: string;
}

const DAY = 86400000;

// Use the same GFM and heading plugins as Preview; regex-generated slugs disagree on
// inline formatting, Chinese punctuation, duplicate headings and reference-style links.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkAlerts).use(remarkShortcodes)
  .use(remarkRehype).use(rehypeSlug);

function visit(node: Root | RootContent, fn: (node: Root | RootContent) => void) {
  fn(node);
  if ("children" in node) for (const child of node.children) visit(child, fn);
}

export function checkHealth(snapshot: HealthSnapshot, now = Date.now()) {
  const issues: HealthIssue[] = [];
  const files = new Set(snapshot.files);
  const byPath = new Map<string, HealthPage>();
  const parsed = snapshot.pages.map(page => {
    byPath.set(page.id === HOME ? "" : page.id, page);
    byPath.set(page.file, page);
    const ast = processor.parse(page.body);
    const tree = processor.runSync(ast) as Root;
    const ids = new Set<string>();
    visit(tree, node => {
      if (node.type === "element" && typeof node.properties.id === "string") ids.add(node.properties.id);
    });
    return { page, tree, ids };
  });
  const anchors = new Map(parsed.map(p => [p.page.id, p.ids]));
  for (const { page, tree } of parsed) {
    const add = (kind: HealthIssue["kind"], target: string, line: number) => {
      issues.push({ page: page.id, title: page.title, kind, target, line, excerpt: line ? page.body.split("\n")[line - 1] ?? "" : "页面属性：替代页面" });
    };
    if (page.meta.replaced_by && (!anchors.has(page.meta.replaced_by) || page.meta.replaced_by === page.id)) {
      add("replacement", page.meta.replaced_by, 0);
    }
    // Drafts are not published yet and deprecated pages are kept as they are on purpose.
    const days = page.updated ? Math.floor((now - Date.parse(page.updated)) / DAY) : 0;
    if (snapshot.stale_days && days >= snapshot.stale_days && !page.meta.draft && !page.meta.deprecated) {
      issues.push({
        page: page.id, title: page.title, kind: "stale", line: 0,
        target: page.meta.owner ? `负责人：${page.meta.owner}` : "未指定负责人",
        excerpt: `${days} 天没有更新，最后更新于 ${new Date(page.updated!).toLocaleDateString()}`,
      });
    }
    visit(tree, node => {
      if (node.type !== "element" || (node.tagName !== "a" && node.tagName !== "img")) return;
      const image = node.tagName === "img";
      const target = node.properties[image ? "src" : "href"];
      if (typeof target !== "string" || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return;
      // Hugo shortcodes have their own resolution rules and are outside this Markdown check.
      if (target.includes("{{")) return;
      const line = node.position?.start.line ?? 0;
      let pathname: string, hash: string;
      try {
        const url = new URL(target, "https://wiki.invalid/" + page.file);
        pathname = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
        hash = decodeURIComponent(url.hash.slice(1));
      } catch {
        add(image ? "asset" : "page", target, line);
        return;
      }
      const dest = byPath.get(pathname);
      if (dest && !image) {
        if (hash && !anchors.get(dest.id)?.has(hash)) add("anchor", target, line);
      } else if (!files.has(pathname)) {
        const asset = image || pathname.includes("/assets/") || /\.[^/]+$/.test(pathname) && !pathname.endsWith(".md");
        add(asset ? "asset" : "page", target, line);
      }
    });
  }
  return issues;
}
