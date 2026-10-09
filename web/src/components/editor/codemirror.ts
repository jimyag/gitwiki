// gitwiki's additions to md-editor-rt's CodeMirror: gutters, code-block styling, highlight
// colours and remote cursors. Loaded with the editor only (see MarkdownEditor).
import { Decoration, EditorView, ViewPlugin, lineNumbers, highlightActiveLineGutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { HighlightStyle, foldGutter, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { remoteCursorsExtension } from "./cursorOverlay";

// Prose uses the reading view's font, size and line height, so edit and preview read alike.
// Colours are index.css tokens, so the editor follows the light/dark theme without rebuilding.
const theme = EditorView.theme({
  "&": { fontSize: "16px", backgroundColor: "transparent", color: "var(--fg-2)" },
  "&.cm-focused": { outline: "none" },
  // Centred with its gutter when the text is narrower than the editor; how wide the text may get
  // (the reading view's width, or all of it) is set in index.css by the editor's width mode.
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.8", justifyContent: "center" },
  ".cm-content": { padding: "12px 0 40vh", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 16px 0 6px" },
  ".cm-cursor": { borderLeft: "1.5px solid var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgb(16 185 129 / 0.2)",
  },
  ".cm-placeholder": { color: "var(--fg-subtle)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--fg-subtle)", opacity: "0.6" },
  // Fixed line height = one 16px prose line, so the small numbers sit level with the text.
  ".cm-gutterElement": { lineHeight: "28.8px" },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "40px", padding: "0 8px 0 0", fontFamily: "var(--font-mono)", fontSize: "11.5px",
  },
  // Fold arrows only while hovering the gutter; a folded one stays visible.
  ".cm-foldGutter .cm-gutterElement": { width: "16px", color: "var(--fg-subtle)", opacity: "0", transition: "opacity .15s" },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:has([title='Unfold line'])": {
    opacity: "1",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-2)" },
  ".cm-selectionMatch": { backgroundColor: "rgb(16 185 129 / 0.14)" },
  ".cm-searchMatch": { backgroundColor: "rgb(245 158 11 / 0.25)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(245 158 11 / 0.5)" },
  // Fenced code reads as a block: monospace on a tinted band (lines marked by codeBlockLines).
  ".cm-codeLine": { fontFamily: "var(--font-mono)", fontSize: "13.5px", backgroundColor: "var(--subtle)" },
  ".cm-tooltip": { backgroundColor: "var(--raised)", color: "var(--fg-2)", border: "none", borderRadius: "10px", boxShadow: "var(--pop-shadow)", overflow: "hidden" },
});

const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "600", color: "var(--fg)" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "600", color: "var(--fg)" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "600", color: "var(--fg)" },
  { tag: t.heading, fontWeight: "600", color: "var(--fg)" },
  { tag: t.strong, fontWeight: "600", color: "var(--fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent-strong)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em", color: "var(--fg-muted)" },
  { tag: t.quote, color: "var(--fg-muted)" },
  // Markdown syntax itself (#, *, `, >, list markers, rules) recedes.
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.atom, t.meta], color: "var(--fg-subtle)" },
  // Tokens inside fenced code (GitHub palettes, see --hl-* in index.css).
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--hl-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "var(--hl-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--hl-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--hl-number)" },
  { tag: t.tagName, color: "var(--hl-tag)" },
]);

const codeLine = Decoration.line({ class: "cm-codeLine" });

function codeLines(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let last = -1; // a block can span two visible ranges; never add a line twice
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to);) {
          const line = view.state.doc.lineAt(pos);
          if (line.from > last) {
            b.add(line.from, line.from, codeLine);
            last = line.from;
          }
          pos = line.to + 1;
        }
        return false;
      },
    });
  }
  return b.finish();
}

const codeBlockLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = codeLines(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = codeLines(u.view);
    }
  }
}, { decorations: v => v.decorations });

// Replaces md-editor-rt's "theme" extension (its oneLight look); the rest of its setup
// (keymaps, history, markdown with fenced-code languages, toolbar commands) stays.
export function gitwikiExtensions(): Extension[] {
  return [
    lineNumbers(),
    foldGutter({ openText: "▾", closedText: "▸" }),
    // Current line shows as a darker number only: a line tint would look like a code block.
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    syntaxHighlighting(markdownStyle),
    codeBlockLines,
    theme,
    remoteCursorsExtension(),
  ];
}
