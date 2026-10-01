// Clipboard HTML → markdown for the editor's paste path. The editor doesn't need to know
// anything about it: we install a capture-phase listener on the wrapper, swap in the
// converted text, and let md-editor-rt's own handler insert it (so images pasted as files
// still go through onUploadImg).
import TurndownService from "turndown";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.remove(["style", "script", "meta", "link"] as unknown as Parameters<TurndownService["remove"]>[0]);
td.addRule("brToNewline", { filter: "br", replacement: () => "\n" });

export function htmlToMarkdown(html: string): string {
  // Feishu/Word wraps heading text in <strong>/<b>: it would otherwise come out inside the
  // "#" line as **bold**.
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(h =>
    h.querySelectorAll("strong,b").forEach(el => el.replaceWith(...el.childNodes)));
  return td.turndown(doc.body);
}

// Intercepts paste events carrying text/html; plain-text pastes and image files are untouched.
export function onHtmlPaste(el: HTMLElement): () => void {
  const handler = (e: ClipboardEvent) => {
    const html = e.clipboardData?.getData("text/html");
    if (!html) return;
    const md = htmlToMarkdown(html).trim();
    if (!md || !md.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    document.execCommand("insertText", false, md);
  };
  el.addEventListener("paste", handler, true);
  return () => el.removeEventListener("paste", handler, true);
}
