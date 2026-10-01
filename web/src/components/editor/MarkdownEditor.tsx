// Markdown source editor: md-editor-rt, a maintained CodeMirror 6 editor with a full toolbar
// (headings, lists, links, image upload, a table size picker …). Its own preview is off: the
// reading view is gitwiki's. Everything ships with the app; nothing is fetched from a CDN.
// Loaded lazily by Editor, so readers never download it.
import { useEffect, useRef, useState } from "react";
import { MdEditor, NormalToolbar, config, type Insert, type ToolbarNames } from "md-editor-rt";
import { Prec } from "@codemirror/state";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Link2, Paperclip } from "lucide-react";
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import "md-editor-rt/lib/style.css";
import { gitwikiExtensions } from "./codemirror";
import { onHtmlPaste } from "../../lib/paste";
import { useStore } from "../../store";
import { flattenTree } from "../../lib/tree";
import { HOME, linkFor } from "../../lib/route";
import { PagePicker } from "../PagePicker";

config({
  // "裁剪上传" would otherwise load cropperjs from unpkg.
  editorExtensions: { cropper: { instance: Cropper } },
  codeMirrorExtensions: (extensions) => [
    ...extensions
      // The source should show URLs as written; the shortener folds long ones into "…".
      .filter(e => e.type !== "linkShortener")
      // Parse GFM like the renderer does (strikethrough, tables, task lists), not CommonMark.
      .map(e => (e.type === "markdown" ? { ...e, extension: markdown({ base: markdownLanguage, codeLanguages: languages }) } : e)),
    // md-editor-rt re-applies its own theme into a compartment after mounting, so filtering it
    // out does not stick; highest precedence mounts our styles last, and equal-specificity
    // rules (token colours, gutters) then resolve to ours.
    { type: "gitwiki", extension: Prec.highest(gitwikiExtensions()) },
  ],
});

// Syntax gitwiki's renderer shows (GFM, alerts, KaTeX math, Mermaid); 0 and 1 are the custom
// buttons in defToolbars below.
const toolbars: ToolbarNames[] = [
  "revoke", "next", "-",
  "title", "bold", "italic", "strikeThrough", "-",
  "quote", "unorderedList", "orderedList", "task", "-",
  "codeRow", "code", "link", 0, "image", 1, "table", "katex", "mermaid",
  "=", "pageFullscreen",
];

const imageName = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

// "[[" followed by part of a title offers the wiki's pages; picking one writes a normal
// markdown link to its path, which Hugo understands as well.
function pageCompletions(ctx: CompletionContext): CompletionResult | null {
  const typed = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!typed) return null;
  const q = typed.text.slice(2).toLowerCase();
  const tree = useStore.getState().tree;
  const pages = flattenTree(tree).filter(p => p.node.has_body).map(p => ({ id: p.id, title: p.title, where: p.where }));
  if (tree?.has_body) pages.unshift({ id: HOME, title: "首页", where: "" });
  return {
    from: typed.from,
    filter: false,
    options: pages
      .filter(p => p.title.toLowerCase().includes(q))
      .slice(0, 50)
      .map((p): Completion => ({
        label: p.title,
        detail: p.where,
        type: "text",
        apply: (view, _c, from, to) => {
          const text = `[${p.title}](${linkFor(p.id)})`;
          // Bracket auto-closing may have typed "]]" after the cursor: replace it too.
          const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
          view.dispatch({ changes: { from, to: end, insert: text }, selection: { anchor: from + text.length } });
        },
      })),
  };
}

const insertAt = (insert: Insert | undefined, text: string) =>
  insert?.(() => ({ targetValue: text, select: false, deviationStart: 0, deviationEnd: 0 }));

// md-editor-rt hands custom toolbar buttons its insert function as a prop.
function PageLinkButton({ insert }: { insert?: Insert }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <NormalToolbar title="插入页面链接（也可以输入 [[）" onClick={() => setOpen(true)}>
        <Link2 className="md-editor-icon" />
      </NormalToolbar>
      {open && (
        <PagePicker
          title="插入页面链接"
          hint="页面以后移动了，链接也会自动跟着更新"
          onClose={() => setOpen(false)}
          onPick={(p) => {
            setOpen(false);
            insert?.((selected) => ({ targetValue: `[${selected || p.title}](${linkFor(p.id)})`, select: false, deviationStart: 0, deviationEnd: 0 }));
          }}
        />
      )}
    </>
  );
}

function AttachButton({ insert, onUpload }: { insert?: Insert; onUpload(file: File): Promise<string> }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <NormalToolbar title="上传附件" onClick={() => input.current?.click()}>
        <Paperclip className="md-editor-icon" />
      </NormalToolbar>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          // A failed file is already reported by onUpload; link the ones that made it.
          const results = await Promise.allSettled(files.map(onUpload));
          const links = results.flatMap((r, i) => {
            if (r.status !== "fulfilled") return [];
            const name = files[i].name.replace(/[[\]]/g, "");
            return [imageName.test(name) ? `![${name}](${r.value})` : `[${name}](${r.value})`];
          });
          if (links.length) insertAt(insert, links.join("\n"));
        }}
      />
    </>
  );
}

export default function MarkdownEditor({ value, onChange, onUpload }: {
  value: string;
  onChange(v: string): void;
  onUpload(file: File): Promise<string>; // resolves to the path to embed, e.g. "assets/x.png"
}) {
  // Rich-text paste (Word/Feishu/web pages) becomes markdown; plain text and files
  // (screenshots) keep going to the editor's own handler.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => (wrapRef.current ? onHtmlPaste(wrapRef.current) : undefined), []);
  return (
    <div ref={wrapRef} className="h-full min-h-0">
    <MdEditor
      className="gitwiki-md"
      value={value}
      onChange={onChange}
      language="zh-CN"
      preview={false}
      noHighlight
      noMermaid
      noKatex
      noEcharts
      noPrettier
      toolbars={toolbars}
      defToolbars={[<PageLinkButton key="page-link" />, <AttachButton key="attach" onUpload={onUpload} />]}
      completions={[pageCompletions]}
      footers={["markdownTotal"]}
      tableShape={[6, 4, 12, 12]}
      placeholder="开始写正文。输入 [[ 可以链接到其他页面"
      autoFocus
      onUploadImg={async (files, done) => {
        // A failed file is already reported by onUpload; insert the ones that made it.
        const results = await Promise.allSettled(files.map(onUpload));
        done(results.flatMap(r => (r.status === "fulfilled" ? [r.value] : [])));
      }}
    />
    </div>
  );
}
