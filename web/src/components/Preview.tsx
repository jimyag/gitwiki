import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Root } from "hast";
import { AlertTriangle, Check, Copy, Info, Lightbulb, MessageSquareWarning, OctagonAlert, Paperclip } from "lucide-react";
import { useStore } from "../store";
import { api, type PageMeta } from "../lib/api";
import { highlight } from "../lib/highlight";
import { pageLink, pathFor, setHash } from "../lib/route";
import { pageExists, pagePath } from "../lib/tree";
import { attachmentName, formatRelativeTime } from "../lib/format";
import { alertLabels, remarkAlerts, remarkShortcodes, useMathPlugins, type AlertType } from "../lib/markdown";
import { Mermaid } from "./Mermaid";

export interface Heading { id: string; text: string; level: number }

const imageExt = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const pdfExt = /\.pdf$/i;

// Memoized: Editor re-renders on unrelated state (save status, presence) and re-parsing the
// markdown each time is wasted work.
export const Preview = memo(function Preview({ body, onHeadings }: {
  body: string;
  onHeadings?: (h: Heading[]) => void; // feeds the table of contents
}) {
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const ref = useRef<HTMLElement>(null);
  const lines = useRef<number[]>([]); // filled by rehypeLines while rendering
  const math = useMathPlugins(body);

  // Each top-level block renders as one element of the article, in order: tag it with its source
  // line, so the editor opens at the block being read and the reading view comes back to the
  // block being edited (see Editor).
  useLayoutEffect(() => {
    [...(ref.current?.children ?? [])].forEach((el, i) => {
      if (lines.current[i]) el.setAttribute("data-line", String(lines.current[i]));
      else el.removeAttribute("data-line");
    });
  }, [body, math]);

  // rehype-slug gives headings their ids; read them back from the DOM for the TOC.
  useLayoutEffect(() => {
    if (!onHeadings || !ref.current) return;
    const sel = "h1[id]:not(.sr-only), h2[id]:not(.sr-only), h3[id]:not(.sr-only)"; // skip the hidden footnotes label
    onHeadings([...ref.current.querySelectorAll<HTMLElement>(sel)].map(h => ({
      id: h.id, text: h.innerText.replace(/^#\s*/, ""), level: Number(h.tagName[1]),
    })));
  }, [body, math, onHeadings]);

  // Attachments are written relative to the page ("assets/x.png") and served by the API.
  const assetUrl = (src: string) =>
    src.startsWith("assets/") && currentRepo && pageId ? api.assetUrl(currentRepo, pageId, decodeURIComponent(src.slice(7))) : src;

  return (
    <article ref={ref} className="prose-preview text-[16px] leading-[1.8] text-fg-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlerts, remarkShortcodes, ...(math ? [math.remark] : [])]}
        rehypePlugins={[rehypeSlug, ...(math ? [math.rehype] : []), [rehypeLines, lines]]}
        remarkRehypeOptions={{ footnoteLabel: "脚注", footnoteBackLabel: "返回正文" }}
        components={{
          img: ({ src, alt, node: _, ...rest }) => <ZoomableImage src={assetUrl(typeof src === "string" ? src : "")} alt={alt ?? ""} {...rest} />,
          a: ({ href, children }) => <Link href={href ?? ""} assetUrl={assetUrl}>{children}</Link>,
          h1: ({ id, children }) => <Heading tag="h1" id={id} className="text-[26px] font-semibold tracking-[-0.01em] text-fg mt-12 mb-4 leading-snug">{children}</Heading>,
          // GFM footnotes come with a visually hidden "脚注" heading: keep it hidden.
          h2: ({ id, className, children }) => className?.includes("sr-only")
            ? <h2 id={id} className="sr-only">{children}</h2>
            : <Heading tag="h2" id={id} className="text-[22px] font-semibold tracking-[-0.01em] text-fg mt-11 mb-3 leading-snug">{children}</Heading>,
          h3: ({ id, children }) => <Heading tag="h3" id={id} className="text-[18px] font-semibold text-fg mt-8 mb-2 leading-snug">{children}</Heading>,
          h4: ({ id, children }) => <Heading tag="h4" id={id} className="text-base font-semibold text-fg mt-6 mb-2">{children}</Heading>,
          p: ({ children }) => <p className="my-4">{children}</p>,
          ul: ({ className, children }) => <ul className={`${className ?? ""} my-4 pl-6 space-y-1.5 list-disc marker:text-fg-subtle`}>{children}</ul>,
          ol: ({ className, children }) => <ol className={`${className ?? ""} my-4 pl-6 space-y-1.5 list-decimal marker:text-fg-muted`}>{children}</ol>,
          // A list inside an item keeps close to it, rather than the gap between paragraphs.
          li: ({ className, children }) => <li className={`${className ?? ""} pl-0.5 [&>ol]:my-1.5 [&>ul]:my-1.5`}>{children}</li>,
          // Only inline code reaches here: fenced blocks are rendered whole by `pre` below.
          code: ({ children }) => (
            <code className="rounded-md bg-shade px-1.5 py-0.5 font-mono text-[0.85em] text-fg">{children}</code>
          ),
          pre: ({ node }) => {
            const code = node?.children[0];
            if (code?.type !== "element" || code.tagName !== "code") return null;
            const cls = (code.properties.className as string[] | undefined) ?? [];
            const lang = cls.find(c => c.startsWith("language-"))?.slice("language-".length);
            const text = code.children.map(c => (c.type === "text" ? c.value : "")).join("").replace(/\n$/, "");
            const block = <CodeBlock lang={lang} code={text} />;
            return lang === "mermaid" ? <Mermaid code={text} fallback={block} /> : block;
          },
          div: ({ node, children, ...rest }) => {
            const alert = node?.properties.dataAlert as AlertType | undefined;
            return alert && alert in alertLabels ? <Alert type={alert}>{children}</Alert> : <div {...rest}>{children}</div>;
          },
          blockquote: ({ children }) => (
            <blockquote className="my-6 border-l-2 border-line-strong pl-4 text-fg-muted [&>p]:my-2">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto rounded-xl ring-1 ring-line">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-subtle text-left">{children}</thead>,
          th: ({ children }) => <th className="px-3.5 py-2.5 text-[13px] font-medium text-fg-muted">{children}</th>,
          td: ({ children }) => <td className="px-3.5 py-2.5 align-top border-t border-line">{children}</td>,
          hr: () => <hr className="my-12 border-t border-line" />,
          strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
});

// rehypeLines records the source line of each top-level element, as rendered (0 for generated
// ones, like the footnotes section).
function rehypeLines(out: { current: number[] }) {
  return (tree: Root) => {
    out.current = tree.children.flatMap(n => (n.type === "element" ? [n.position?.start.line ?? 0] : []));
  };
}

const linkClass = "text-accent-strong underline decoration-accent/35 underline-offset-[3px] transition-colors hover:decoration-accent";

// Link resolves what a page links to: another wiki page (opened in place; marked when it does
// not exist), an attachment, a section of this page, or another site.
function Link({ href, assetUrl, children }: { href: string; assetUrl(src: string): string; children?: ReactNode }) {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree);
  const target = pageLink(href);
  // Hovering a link to another page shows what that page is about (mouse only: a tap opens it).
  const [card, setCard] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (target && repo) {
    const missing = tree !== null && !pageExists(tree, target.id);
    const other = !missing && target.id !== useStore.getState().currentPageId;
    const hide = () => { clearTimeout(timer.current); setCard(null); };
    return (
      <>
        <a
          href={pathFor(repo, target.id) + target.hash}
          onClick={(e) => {
            hide();
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab/window: let the browser go
            e.preventDefault();
            const section = target.hash && decodeURIComponent(target.hash.slice(1));
            if (target.id === useStore.getState().currentPageId) {
              if (section) scrollToSection(section);
              return;
            }
            // The table of contents reads the hash when the page opens and scrolls there.
            if (useStore.getState().openPage(target.id) && section) history.replaceState(null, "", location.pathname + target.hash);
          }}
          onPointerEnter={(e) => {
            if (!other || e.pointerType !== "mouse") return;
            const el = e.currentTarget;
            timer.current = setTimeout(() => setCard(el.getBoundingClientRect()), 400);
          }}
          onPointerLeave={hide}
          title={missing ? "页面不存在（可能已被删除或移动）" : undefined}
          className={missing ? "text-red-600 underline decoration-dashed decoration-red-400/70 underline-offset-[3px] dark:text-red-400" : linkClass}
        >{children}</a>
        {card && <LinkCard repo={repo} id={target.id} at={card} />}
      </>
    );
  }
  if (href.startsWith("assets/")) {
    const name = decodeURIComponent(href.slice(7));
    const img = imageExt.test(name);
    const pdf = pdfExt.test(name);
    if (pdf) {
      return <PdfPreview href={assetUrl(href)}>{children}</PdfPreview>;
    }
    return (
      <a href={assetUrl(href)} download={!img ? attachmentName(name) : undefined} target={img ? "_blank" : undefined} className={linkClass}>
        {!img && <Paperclip className="inline size-3.5 mr-0.5 -mt-0.5" />}{children}
      </a>
    );
  }
  if (href.startsWith("#")) {
    return (
      <a href={href} onClick={(e) => { e.preventDefault(); scrollToSection(decodeURIComponent(href.slice(1))); }} className={linkClass}>
        {children}
      </a>
    );
  }
  const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
  return (
    <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className={linkClass}>
      {children}
    </a>
  );
}

interface Summary { title: string; text: string; updated?: string }

// Each linked page is fetched once while the wiki stays the same: any change replaces the tree.
const summaries = new Map<string, Promise<Summary>>();
let summariesOf: PageMeta | null = null;

function summary(repo: string, id: string, tree: PageMeta | null): Promise<Summary> {
  if (tree !== summariesOf) {
    summaries.clear();
    summariesOf = tree;
  }
  const key = `${repo}/${id}`;
  let p = summaries.get(key);
  if (!p) {
    p = api.readPage(repo, id).then(pc => ({ title: pc.title || id, text: pc.meta.description || excerpt(pc.body), updated: pc.last_commit_at }));
    p.catch(() => summaries.delete(key)); // try again on the next hover
    summaries.set(key, p);
  }
  return p;
}

// excerpt is how a page starts, as plain text: markup, code, images and Hugo shortcodes left out.
function excerpt(body: string): string {
  const text = body
    .replace(/(```|~~~)[\s\S]*?\1/g, " ")
    .replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)|<[^>]+>|\[!\w+\]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s|>\s?|[-*+]\s+(\[[ x]\]\s)?|\d+\.\s)/gim, "")
    .replace(/[*_`~|$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

function LinkCard({ repo, id, at }: { repo: string; id: string; at: DOMRect }) {
  const tree = useStore(s => s.tree);
  const [info, setInfo] = useState<Summary | null>(null);
  useEffect(() => {
    let live = true;
    summary(repo, id, tree).then(s => { if (live) setInfo(s); }, () => {});
    return () => { live = false; };
  }, [repo, id, tree]);
  const path = pagePath(tree, id);
  const where = path.slice(0, -1).map(n => n.title).join(" / ");
  // Below the link, or above it near the bottom of the window; never off its sides.
  const below = at.bottom + 160 < innerHeight;
  const style = { left: Math.max(8, Math.min(at.left, innerWidth - 328)), ...(below ? { top: at.bottom + 8 } : { bottom: innerHeight - at.top + 8 }) };
  return createPortal(
    <div role="tooltip" style={style} className="pointer-events-none fixed z-50 w-80 rounded-xl bg-raised px-4 py-3 shadow-pop animate-pop-in">
      {where && <div className="truncate text-xs text-fg-subtle">{where}</div>}
      <div className="text-sm font-semibold text-fg">{info?.title ?? path.at(-1)?.title ?? id}</div>
      {info ? (
        <>
          {info.text && <p className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-fg-muted">{info.text}</p>}
          {info.updated && <div className="mt-2 text-xs text-fg-subtle">更新于 {formatRelativeTime(info.updated)}</div>}
        </>
      ) : <div className="mt-2 h-3 w-3/4 rounded bg-shade animate-pulse" />}
    </div>,
    document.body,
  );
}

function ZoomableImage({ src, alt, ...rest }: { src: string; alt: string; [k: string]: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        {...rest}
        className="my-6 max-w-full rounded-xl ring-1 ring-line cursor-zoom-in"
        loading="lazy"
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/85 p-6 backdrop-blur-sm cursor-zoom-out animate-fade-in" onClick={() => setOpen(false)}>
          <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}

// PDF 附件：标题后面跟一个展开的内嵌预览，浏览器自带的 PDF 阅读器。
function PdfPreview({ href, children }: { href: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
        <Paperclip className="inline size-3.5 mr-0.5 -mt-0.5" />{children}
      </a>
      <button onClick={() => setOpen(o => !o)} className="rounded-md px-1.5 text-xs text-fg-muted transition-colors hover:bg-shade hover:text-fg">
        {open ? "收起" : "预览"}
      </button>
      {open && (
        <span className="block w-full my-3 overflow-hidden rounded-xl ring-1 ring-line" style={{ gridColumn: "1/-1" }}>
          <iframe src={href} title="PDF 预览" className="w-full h-[70vh] bg-white" />
        </span>
      )}
    </span>
  );
}

function scrollToSection(id: string) {
  setHash(id);
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const alertStyle: Record<AlertType, { icon: typeof Info; box: string; title: string }> = {
  note: { icon: Info, box: "bg-sky-500/10 ring-sky-500/25", title: "text-sky-700 dark:text-sky-300" },
  tip: { icon: Lightbulb, box: "bg-emerald-500/10 ring-emerald-500/25", title: "text-emerald-700 dark:text-emerald-300" },
  important: { icon: MessageSquareWarning, box: "bg-violet-500/10 ring-violet-500/25", title: "text-violet-700 dark:text-violet-300" },
  warning: { icon: AlertTriangle, box: "bg-amber-500/10 ring-amber-500/30", title: "text-amber-800 dark:text-amber-300" },
  caution: { icon: OctagonAlert, box: "bg-red-500/10 ring-red-500/25", title: "text-red-700 dark:text-red-300" },
};

function Alert({ type, children }: { type: AlertType; children?: ReactNode }) {
  const s = alertStyle[type];
  return (
    <div className={`my-6 rounded-xl px-4 py-3.5 ring-1 ring-inset ${s.box} [&>p]:my-1.5 [&>p:last-child]:mb-0`}>
      <div className={`flex items-center gap-1.5 text-sm font-semibold ${s.title}`}>
        <s.icon className="size-4" />{alertLabels[type]}
      </div>
      {children}
    </div>
  );
}

function Heading({ tag: Tag, id, className, children }: {
  tag: "h1" | "h2" | "h3" | "h4"; id?: string; className: string; children?: ReactNode;
}) {
  return (
    <Tag id={id} className={`group relative scroll-mt-6 ${className}`}>
      {id && (
        <a
          href={`#${encodeURIComponent(id)}`}
          onClick={(e) => {
            e.preventDefault();
            scrollToSection(id);
          }}
          aria-hidden
          tabIndex={-1}
          className="absolute -left-5 top-0 w-5 text-fg-subtle opacity-0 transition group-hover:opacity-100 hover:text-accent-strong"
        >#</a>
      )}
      {children}
    </Tag>
  );
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    highlight(code, lang).then(h => { if (live) setHtml(h); }, () => {}); // unknown/failed: stay plain
    return () => { live = false; };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="code-block my-6 overflow-hidden rounded-xl bg-subtle ring-1 ring-line">
      <div className="flex items-center h-9 pl-4 pr-1.5 border-b border-line text-xs text-fg-muted">
        <span className="font-mono">{lang || "text"}</span>
        <button
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 h-7 px-2 rounded-md text-fg-muted transition-colors hover:bg-shade hover:text-fg"
        >
          {copied ? <><Check className="size-3.5 text-accent-strong" />已复制</> : <><Copy className="size-3.5" />复制</>}
        </button>
      </div>
      {/* Same span.line structure as Shiki's output, so line numbers show before highlighting loads. */}
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre><code>{code.split("\n").map((l, i) => <Fragment key={i}>{i > 0 && "\n"}<span className="line">{l}</span></Fragment>)}</code></pre>
      )}
    </div>
  );
}
