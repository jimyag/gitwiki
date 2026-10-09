// Markdown source editor: md-editor-rt, a maintained CodeMirror 6 editor with a full toolbar
// (headings, lists, links, image upload, a table size picker …). Its own preview is off: the
// reading view is gitwiki's. Everything ships with the app; nothing is fetched from a CDN.
// Loaded lazily by Editor, so readers never download it.
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { MdEditor, NormalToolbar, config, type ExposeParam, type Insert, type ToolbarNames } from "md-editor-rt";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Columns2, FoldHorizontal, Link2, Maximize2, Minimize2, Paperclip, UnfoldHorizontal } from "lucide-react";
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import "md-editor-rt/lib/style.css";
import { gitwikiExtensions } from "./codemirror";
import { onHtmlPaste } from "../../lib/paste";
import { useStore } from "../../store";
import { flattenTree } from "../../lib/tree";
import { HOME, linkFor } from "../../lib/route";
import { useDark } from "../../lib/theme";
import { PagePicker } from "../PagePicker";

config({
  // "裁剪上传" would otherwise load cropperjs from unpkg.
  editorExtensions: { cropper: { instance: Cropper } },
  codeMirrorExtensions: (extensions, { keyBindings }) => [
    ...extensions
      // The source should show URLs as written; the shortener folds long ones into "…".
      .filter(e => e.type !== "linkShortener")
      // Parse GFM like the renderer does (strikethrough, tables, task lists), not CommonMark.
      .map(e => (e.type === "markdown" ? { ...e, extension: markdown({ base: markdownLanguage, codeLanguages: languages }) } : e))
      // Its Ctrl/Cmd-↑ ↓ write superscript and subscript marks the renderer does not show, and
      // take those keys from the jump to the start or end of the document.
      .map(e => (e.type === "keymap"
        ? { ...e, extension: keymap.of(keyBindings.filter(k => k.key !== "Ctrl-ArrowUp" && k.key !== "Ctrl-ArrowDown")) }
        : e)),
    // md-editor-rt re-applies its own theme into a compartment after mounting, so filtering it
    // out does not stick; highest precedence mounts our styles last, and equal-specificity
    // rules (token colours, gutters) then resolve to ours.
    { type: "gitwiki", extension: Prec.highest(gitwikiExtensions()) },
  ],
});

// Syntax gitwiki's renderer shows (GFM, alerts, KaTeX math, Mermaid); 0 to 4 are the custom
// buttons in defToolbars below.
const toolbars: ToolbarNames[] = [
  "revoke", "next", "-",
  "title", "bold", "italic", "strikeThrough", "-",
  "quote", "unorderedList", "orderedList", "task", "-",
  "codeRow", "code", "link", 0, "image", 1, "table", "katex", "mermaid",
  "=", 4, 2, 3,
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

// "/" at the start of a line offers blocks to insert, found by their name or an English word
// ("/表格", "/table"). ‸ marks where the cursor goes; without it, at the end.
const blocks = [
  { label: "一级标题", keys: "h1 heading", text: "# " },
  { label: "二级标题", keys: "h2 heading", text: "## " },
  { label: "三级标题", keys: "h3 heading", text: "### " },
  { label: "无序列表", keys: "list bullet ul", text: "- " },
  { label: "有序列表", keys: "list number ol", text: "1. " },
  { label: "任务列表", keys: "todo task checkbox", text: "- [ ] " },
  { label: "引用", keys: "quote", text: "> " },
  { label: "代码块", keys: "code", text: "```\n‸\n```\n" },
  { label: "表格", keys: "table", text: "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| ‸ |  |  |\n" },
  { label: "提示块：说明", keys: "note alert callout", text: "> [!NOTE]\n> " },
  { label: "提示块：提示", keys: "tip alert callout", text: "> [!TIP]\n> " },
  { label: "提示块：重要", keys: "important alert callout", text: "> [!IMPORTANT]\n> " },
  { label: "提示块：警告", keys: "warning alert callout", text: "> [!WARNING]\n> " },
  { label: "提示块：注意", keys: "caution alert callout", text: "> [!CAUTION]\n> " },
  { label: "Mermaid 图", keys: "mermaid diagram flowchart chart", text: "```mermaid\nflowchart LR\n  A[开始] --> B[结束]‸\n```\n" },
  { label: "公式块", keys: "math formula katex", text: "$$\n‸\n$$\n" },
  { label: "分割线", keys: "divider hr line", text: "---\n" },
  { label: "页面链接", keys: "link page wiki", text: "[[" },
];

function slashCommands(ctx: CompletionContext): CompletionResult | null {
  const typed = ctx.matchBefore(/^\s*\/[^\s/]*$/);
  if (!typed) return null;
  // Paths in code examples start lines with "/" too.
  let code = false;
  syntaxTree(ctx.state).iterate({
    from: ctx.pos, to: ctx.pos,
    enter: n => { code ||= n.name === "FencedCode" || n.name === "CodeBlock"; },
  });
  if (code) return null;
  const from = typed.from + typed.text.indexOf("/");
  const q = ctx.state.sliceDoc(from + 1, ctx.pos).toLowerCase();
  const options = blocks
    .filter(b => !q || b.label.toLowerCase().includes(q) || b.keys.split(" ").some(k => k.startsWith(q)))
    .map((b): Completion => ({
      label: b.label,
      detail: b.text.split("\n")[0].replace("‸", "").trim().slice(0, 12),
      type: "text",
      apply: (view, _c, start, end) => {
        const at = b.text.indexOf("‸");
        const insert = b.text.replace("‸", "");
        view.dispatch({ changes: { from: start, to: end, insert }, selection: { anchor: start + (at < 0 ? insert.length : at) } });
        if (insert === "[[") startCompletion(view);
      },
    }));
  // Nothing matches: Enter must stay a line break.
  return options.length ? { from, options, filter: false } : null;
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

// The view controls at the end of the toolbar carry their names: unlike bold or lists, their
// icons do not say what they do.

// A page-wide column, or the whole panel: wide tables and long code lines read better unwrapped.
function WidthButton({ wide, onChange }: { wide: boolean; onChange(wide: boolean): void }) {
  const label = wide ? "恢复单页宽度" : "铺满宽度";
  return (
    <NormalToolbar title={label} onClick={() => onChange(!wide)}>
      {wide ? <FoldHorizontal className="md-editor-icon gitwiki-width" /> : <UnfoldHorizontal className="md-editor-icon gitwiki-width" />}
      <span className="gitwiki-tool-label">{label}</span>
    </NormalToolbar>
  );
}

// The reading view's rendering beside the source, so formulas, diagrams and alerts show as
// they are typed.
function SplitButton({ split, onChange }: { split: boolean; onChange(split: boolean): void }) {
  const label = split ? "关闭分屏" : "分屏预览";
  return (
    <NormalToolbar title={label} onClick={() => onChange(!split)}>
      <Columns2 className="md-editor-icon gitwiki-split" />
      <span className="gitwiki-tool-label">{label}</span>
    </NormalToolbar>
  );
}

// The editor (and the split preview with it) over the whole window. Editor lays it out:
// md-editor-rt's own full-screen mode would leave the preview behind.
function FullscreenButton({ full, onChange }: { full: boolean; onChange(full: boolean): void }) {
  const label = full ? "退出全屏" : "全屏";
  return (
    <NormalToolbar title={label} onClick={() => onChange(!full)}>
      {full ? <Minimize2 className="md-editor-icon" /> : <Maximize2 className="md-editor-icon" />}
      <span className="gitwiki-tool-label">{label}</span>
    </NormalToolbar>
  );
}

// The source line of the first line block showing at the top of the editor.
function topLine(view: EditorView): number {
  const top = view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop);
  return view.state.doc.lineAt(top.from).number;
}

// What Editor asks of the open editor when switching back to the reading view.
export interface EditorHandle {
  topLine(): number; // the source line at the top of the editor
}

export default function MarkdownEditor({ value, onChange, onUpload, line, wide, onWideChange, split, onSplitChange, full, onFullChange, onScrollLine, ref }: {
  value: string;
  onChange(v: string): void;
  onUpload(file: File): Promise<string>; // resolves to the path to embed, e.g. "assets/x.png"
  line: number; // source line to open at, with the cursor at its start (0: the top)
  wide: boolean; // lines use the editor's whole width instead of the reading view's
  onWideChange(wide: boolean): void;
  split: boolean; // the preview shows beside the editor
  onSplitChange(split: boolean): void;
  full: boolean; // the editor covers the window
  onFullChange(full: boolean): void;
  onScrollLine?(line: number): void; // the source line at the top, as the editor scrolls
  ref?: Ref<EditorHandle>;
}) {
  // Rich-text paste (Word/Feishu/web pages) becomes markdown; plain text and files
  // (screenshots) keep going to the editor's own handler.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => (wrapRef.current ? onHtmlPaste(wrapRef.current) : undefined), []);

  const md = useRef<ExposeParam>(null);
  // Colours come from index.css either way; the switch is for md-editor-rt's own dark-only rules.
  const dark = useDark();
  useImperativeHandle(ref, () => ({
    topLine() {
      const view = md.current?.getEditorView();
      return view ? topLine(view) : 0;
    },
  }), []);
  // Listened for on the wrapper (scroll events reach it while capturing): md-editor-rt may create
  // its view after this effect runs.
  const scrolled = useRef(onScrollLine);
  scrolled.current = onScrollLine;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let frame = 0;
    const onScroll = (e: Event) => {
      const view = md.current?.getEditorView();
      if (!view || e.target !== view.scrollDOM) return;
      frame ||= requestAnimationFrame(() => { frame = 0; scrolled.current?.(topLine(view)); });
    };
    wrap.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      wrap.removeEventListener("scroll", onScroll, { capture: true });
      cancelAnimationFrame(frame);
    };
  }, []);
  // Only where it opens: md-editor-rt creates its view in an effect of its own, which runs first.
  useEffect(() => {
    const view = md.current?.getEditorView();
    if (!view || line < 2) return;
    const at = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
  }, []);

  return (
    <div ref={wrapRef} className="h-full min-h-0">
    <MdEditor
      ref={md}
      className={"gitwiki-md" + (wide ? " gitwiki-md-wide" : "")}
      theme={dark ? "dark" : "light"}
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
      defToolbars={[
        <PageLinkButton key="page-link" />,
        <AttachButton key="attach" onUpload={onUpload} />,
        <WidthButton key="width" wide={wide} onChange={onWideChange} />,
        <FullscreenButton key="fullscreen" full={full} onChange={onFullChange} />,
        <SplitButton key="split" split={split} onChange={onSplitChange} />,
      ]}
      completions={[pageCompletions, slashCommands]}
      footers={["markdownTotal"]}
      tableShape={[6, 4, 12, 12]}
      placeholder="开始写正文。行首输入 / 插入表格、提示块等，输入 [[ 链接到其他页面"
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
