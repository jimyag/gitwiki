// gitwiki's additions to md-editor-rt's CodeMirror: gutters, code-block styling, highlight
// colours and remote cursors. Loaded with the editor only (see MarkdownEditor).
import { Decoration, EditorView, ViewPlugin, lineNumbers, highlightActiveLineGutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { HighlightStyle, foldGutter, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { remoteCursorsExtension } from "./cursorOverlay";

// Prose uses the reading view's font, size and line height, so edit and preview read alike.
const theme = EditorView.theme({
  "&": { fontSize: "16px", backgroundColor: "#fff" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.8" },
  ".cm-content": { padding: "12px 0 40vh", caretColor: "#1c1917" },
  ".cm-line": { padding: "0 16px 0 6px" },
  ".cm-cursor": { borderLeft: "1.5px solid #1c1917" },
  ".cm-placeholder": { color: "#a8a29e" },
  ".cm-gutters": { backgroundColor: "#fff", border: "none", color: "#d6d3d1" },
  // Fixed line height = one 16px prose line, so the small numbers sit level with the text.
  ".cm-gutterElement": { lineHeight: "28.8px" },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "40px", padding: "0 8px 0 0", fontFamily: "var(--font-mono)", fontSize: "11.5px",
  },
  // Fold arrows only while hovering the gutter; a folded one stays visible.
  ".cm-foldGutter .cm-gutterElement": { width: "16px", color: "#a8a29e", opacity: "0", transition: "opacity .15s" },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:has([title='Unfold line'])": {
    opacity: "1",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#78716c" },
  ".cm-selectionMatch": { backgroundColor: "rgb(5 150 105 / 0.12)" },
  ".cm-searchMatch": { backgroundColor: "rgb(245 158 11 / 0.25)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(245 158 11 / 0.5)" },
  // Fenced code reads as a block: monospace on a tinted band (lines marked by codeBlockLines).
  ".cm-codeLine": { fontFamily: "var(--font-mono)", fontSize: "13.5px", backgroundColor: "#fafaf9" },
});

const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "600" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "600" },
  { tag: t.heading3, fontSize: "1.12em", fontWeight: "600" },
  { tag: t.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "600", color: "#1c1917" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#047857" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em", color: "#57534e" },
  { tag: t.quote, color: "#78716c" },
  // Markdown syntax itself (#, *, `, >, list markers, rules) recedes.
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.atom, t.meta], color: "#a8a29e" },
  // Tokens inside fenced code (GitHub light palette).
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "#cf222e" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "#0550ae" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.propertyName, t.attributeName], color: "#0550ae" },
  { tag: t.tagName, color: "#116329" },
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
