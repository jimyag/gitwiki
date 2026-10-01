import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { AlertTriangle, Check, Copy, Info, Lightbulb, MessageSquareWarning, OctagonAlert, Paperclip } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { highlight } from "../lib/highlight";
import { pageLink, pathFor, setHash } from "../lib/route";
import { pageExists } from "../lib/tree";
import { attachmentName } from "../lib/format";
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
  const math = useMathPlugins(body);

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
    <article ref={ref} className="prose-preview text-[16px] text-stone-700">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAlerts, remarkShortcodes, ...(math ? [math.remark] : [])]}
        rehypePlugins={[rehypeSlug, ...(math ? [math.rehype] : [])]}
        remarkRehypeOptions={{ footnoteLabel: "脚注", footnoteBackLabel: "返回正文" }}
        components={{
          img: ({ src, alt, node: _, ...rest }) => <ZoomableImage src={assetUrl(typeof src === "string" ? src : "")} alt={alt ?? ""} {...rest} />,
          a: ({ href, children }) => <Link href={href ?? ""} assetUrl={assetUrl}>{children}</Link>,
          h1: ({ id, children }) => <Heading tag="h1" id={id} className="text-[26px] font-semibold tracking-tight text-stone-900 mt-10 mb-4 leading-snug">{children}</Heading>,
          // GFM footnotes come with a visually hidden "脚注" heading: keep it hidden.
          h2: ({ id, className, children }) => className?.includes("sr-only")
            ? <h2 id={id} className="sr-only">{children}</h2>
            : <Heading tag="h2" id={id} className="text-[22px] font-semibold tracking-tight text-stone-900 mt-9 mb-3 leading-snug">{children}</Heading>,
          h3: ({ id, children }) => <Heading tag="h3" id={id} className="text-[18px] font-semibold text-stone-900 mt-7 mb-2 leading-snug">{children}</Heading>,
          h4: ({ id, children }) => <Heading tag="h4" id={id} className="text-base font-semibold text-stone-900 mt-6 mb-2">{children}</Heading>,
          p: ({ children }) => <p className="my-4 leading-[1.8]">{children}</p>,
          ul: ({ className, children }) => <ul className={`${className ?? ""} my-4 pl-6 space-y-1 list-disc marker:text-stone-300`}>{children}</ul>,
          ol: ({ className, children }) => <ol className={`${className ?? ""} my-4 pl-6 space-y-1 list-decimal marker:text-stone-400`}>{children}</ol>,
          li: ({ className, children }) => <li className={`${className ?? ""} leading-[1.8] pl-0.5`}>{children}</li>,
          // Only inline code reaches here: fenced blocks are rendered whole by `pre` below.
          code: ({ children }) => (
            <code className="bg-stone-100 text-stone-800 rounded px-1.5 py-0.5 text-[0.875em] font-mono">{children}</code>
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
            <blockquote className="border-l-[3px] border-stone-200 pl-4 my-5 text-stone-500 [&>p]:my-2">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-5 rounded-lg border border-stone-200">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-stone-50 text-left">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-2 font-medium text-stone-600 border-b border-stone-200">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top border-t border-stone-100">{children}</td>,
          hr: () => <hr className="my-10 border-t border-stone-200" />,
          strong: ({ children }) => <strong className="font-semibold text-stone-900">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
        }}
      >
        {body}
      </ReactMarkdown>
    </article>
  );
});

const linkClass = "text-emerald-700 underline decoration-emerald-700/30 underline-offset-[3px] hover:decoration-emerald-700";

// Link resolves what a page links to: another wiki page (opened in place; marked when it does
// not exist), an attachment, a section of this page, or another site.
function Link({ href, assetUrl, children }: { href: string; assetUrl(src: string): string; children?: ReactNode }) {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree);
  const target = pageLink(href);

  if (target && repo) {
    const missing = tree !== null && !pageExists(tree, target.id);
    return (
      <a
        href={pathFor(repo, target.id) + target.hash}
        onClick={(e) => {
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
        title={missing ? "页面不存在（可能已被删除或移动）" : undefined}
        className={missing ? "text-red-600 underline decoration-dashed decoration-red-300 underline-offset-[3px]" : linkClass}
      >{children}</a>
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

function ZoomableImage({ src, alt, ...rest }: { src: string; alt: string; [k: string]: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        {...rest}
        className="max-w-full rounded-lg border border-stone-200 my-5 cursor-zoom-in"
        loading="lazy"
        onClick={() => setOpen(true)}
      />
      {open && (
        <div className="fixed inset-0 z-50 bg-stone-950/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setOpen(false)}>
          <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded shadow-2xl" />
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
      <button onClick={() => setOpen(o => !o)} className="text-xs text-stone-400 hover:text-stone-600 underline underline-offset-2">
        {open ? "收起" : "预览"}
      </button>
      {open && (
        <span className="block w-full my-3 rounded-lg border border-stone-200 overflow-hidden" style={{ gridColumn: "1/-1" }}>
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
  note: { icon: Info, box: "border-sky-500 bg-sky-50/60", title: "text-sky-700" },
  tip: { icon: Lightbulb, box: "border-emerald-500 bg-emerald-50/60", title: "text-emerald-700" },
  important: { icon: MessageSquareWarning, box: "border-violet-500 bg-violet-50/60", title: "text-violet-700" },
  warning: { icon: AlertTriangle, box: "border-amber-500 bg-amber-50/70", title: "text-amber-800" },
  caution: { icon: OctagonAlert, box: "border-red-500 bg-red-50/60", title: "text-red-700" },
};

function Alert({ type, children }: { type: AlertType; children?: ReactNode }) {
  const s = alertStyle[type];
  return (
    <div className={`my-5 rounded-r-lg border-l-[3px] px-4 py-3 ${s.box} [&>p]:my-1.5 [&>p:last-child]:mb-0`}>
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
          className="absolute -left-5 top-0 w-5 text-stone-300 opacity-0 group-hover:opacity-100 hover:text-emerald-600 transition"
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
    <div className="code-block group my-5 rounded-lg border border-stone-200 bg-stone-50/70 overflow-hidden">
      <div className="flex items-center h-8 pl-3 pr-1.5 border-b border-stone-200/80 text-xs text-stone-400">
        <span className="font-mono">{lang || "text"}</span>
        <button
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 h-6 px-1.5 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-200/60 transition"
        >
          {copied ? <><Check className="size-3.5 text-emerald-600" />已复制</> : <><Copy className="size-3.5" />复制</>}
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
