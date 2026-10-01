// remark plugins for markdown that Hugo renders but plain GFM does not.
import { useEffect, useState } from "react";
import type { PhrasingContent, Root, RootContent, Text } from "mdast";
import type { Options } from "react-markdown";

type Node = Root | RootContent;
type Pluggable = NonNullable<Options["remarkPlugins"]>[number];

function visit(node: Node, fn: (n: Node) => void) {
  fn(node);
  if ("children" in node) for (const c of node.children) visit(c, fn);
}

export const alertLabels = { note: "说明", tip: "提示", important: "重要", warning: "警告", caution: "注意" };
export type AlertType = keyof typeof alertLabels;

// GitHub-style alerts: a blockquote whose first line is [!NOTE], [!TIP], [!IMPORTANT],
// [!WARNING] or [!CAUTION]. Hugo hands them to the theme's blockquote render hook; here the
// blockquote becomes <div data-alert="note"> for Preview to draw.
export function remarkAlerts() {
  return (tree: Root) => visit(tree, (node) => {
    if (node.type !== "blockquote") return;
    const first = node.children[0];
    if (first?.type !== "paragraph") return;
    const text = first.children[0];
    if (text?.type !== "text") return;
    const m = /^\[!(note|tip|important|warning|caution)\][^\S\n]*(?:\n|$)/i.exec(text.value);
    if (!m) return;
    text.value = text.value.slice(m[0].length);
    if (!text.value) {
      first.children.shift();
      if (first.children[0]?.type === "break") first.children.shift();
    }
    if (first.children.length === 0) node.children.shift();
    node.data = { hName: "div", hProperties: { dataAlert: m[1].toLowerCase() } } as typeof node.data;
  });
}

const shortcode = /\{\{([<%])[\s\S]*?[>%]\}\}/g;

// Hugo shortcodes ({{< name args >}}, {{% name %}}) only render on the Hugo site; the wiki shows
// each one as a labelled chip instead of raw template syntax. Code keeps them verbatim.
export function remarkShortcodes() {
  return (tree: Root) => visit(tree, (node) => {
    if (!("children" in node)) return; // code and inline code have no children: left verbatim
    const kids = node.children as RootContent[];
    if (!kids.some(c => c.type === "text" && c.value.includes("{{"))) return;
    (node as { children: RootContent[] }).children = kids.flatMap((c): RootContent[] => (c.type === "text" ? splitShortcodes(c) : [c]));
  });
}

function splitShortcodes(t: Text): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  for (const m of t.value.matchAll(shortcode)) {
    if (m.index > last) out.push({ type: "text", value: t.value.slice(last, m.index) });
    out.push({
      type: "text",
      value: m[0],
      data: { hName: "span", hProperties: { className: ["hugo-shortcode"], title: "这里的内容会在发布后的站点上显示" } } as Text["data"],
    });
    last = m.index + m[0].length;
  }
  if (last === 0) return [t];
  if (last < t.value.length) out.push({ type: "text", value: t.value.slice(last) });
  return out;
}

// Math ($…$ inline, $$…$$ display, as remark-math and Hugo's passthrough extension read it)
// needs KaTeX, which is big: it loads the first time a page contains a dollar pair.
const mathHint = /\$\$|\$[^\s$][^$\n]*\$/;
let mathPlugins: { remark: Pluggable; rehype: Pluggable } | null = null;
let mathLoading: Promise<void> | null = null;

export function useMathPlugins(body: string) {
  const needed = mathHint.test(body);
  const [, loaded] = useState(0);
  useEffect(() => {
    if (!needed || mathPlugins) return;
    mathLoading ??= Promise.all([import("remark-math"), import("rehype-katex"), import("katex/dist/katex.min.css")])
      .then(([math, katex]) => { mathPlugins = { remark: math.default, rehype: katex.default }; });
    let live = true;
    mathLoading.then(() => live && loaded(n => n + 1), () => {});
    return () => { live = false; };
  }, [needed]);
  return needed ? mathPlugins : null;
}
