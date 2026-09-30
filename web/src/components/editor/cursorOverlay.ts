import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { StateField, StateEffect, RangeSet } from "@codemirror/state";
import { useStore, type RemoteCursor } from "../../store";
import { sendCursor } from "../../lib/ws";

// Effect to push the latest remote cursors into the editor.
export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

class CursorWidget extends WidgetType {
  constructor(public user: string, public color: string) { super(); }
  toDOM() {
    const el = document.createElement("span");
    el.className = "remote-cursor";
    el.style.cssText = `
      position: relative;
      display: inline-block;
      width: 2px;
      height: 1.2em;
      margin: 0 -1px;
      vertical-align: text-bottom;
      background: ${this.color};
    `;
    const tag = document.createElement("span");
    tag.textContent = this.user;
    tag.style.cssText = `
      position: absolute;
      bottom: 100%;
      left: -2px;
      background: ${this.color};
      color: white;
      font-size: 10px;
      font-weight: 500;
      padding: 1px 6px;
      border-radius: 3px 3px 3px 0;
      white-space: nowrap;
      font-family: ui-sans-serif, system-ui;
      pointer-events: none;
      line-height: 1;
    `;
    el.appendChild(tag);
    return el;
  }
  eq(other: CursorWidget) {
    return other.user === this.user && other.color === this.color;
  }
}

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => RangeSet.empty,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRemoteCursors)) {
        const ranges = e.value.flatMap(c => {
          const out = [];
          if (c.head !== c.anchor) {
            // selection: highlight range
            const from = Math.min(c.anchor, c.head);
            const to = Math.max(c.anchor, c.head);
            out.push(Decoration.mark({
              class: "remote-selection",
              attributes: { style: `background: color-mix(in srgb, ${c.color} 18%, transparent);` },
            }).range(from, to));
          }
          // cursor at head
          out.push(Decoration.widget({
            widget: new CursorWidget(c.user, c.color),
            side: 1,
          }).range(c.head));
          return out;
        });
        deco = RangeSet.of(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Local selection broadcast plugin.
let lastSent = 0;
function broadcastSel(u: ViewUpdate) {
  const now = Date.now();
  if (now - lastSent < 80) return; // ~12Hz throttle
  if (!u.selectionSet && !u.docChanged) return;
  lastSent = now;
  const sel = u.state.selection.main;
  sendCursor(sel.anchor, sel.head);
}

const broadcaster = ViewPlugin.fromClass(class {
  update(u: ViewUpdate) { broadcastSel(u); }
});

// Subscription plugin: forward store updates into the field.
// ponytail: simplest pub/sub — recompute decorations on any store change; perf fine for <10 peers.
const subscriber = ViewPlugin.fromClass(class {
  private unsub: () => void;
  constructor(view: EditorView) {
    this.unsub = useStore.subscribe((s, prev) => {
      if (s.remoteCursors === prev.remoteCursors) return;
      // Filter stale cursors (>10s)
      const now = Date.now();
      const list = Object.values(s.remoteCursors).filter(c => now - c.at < 10_000);
      // Clamp positions to doc length
      const max = view.state.doc.length;
      const safe = list
        .filter(c => c.anchor >= 0 && c.head >= 0)
        .map(c => ({ ...c, anchor: Math.min(c.anchor, max), head: Math.min(c.head, max) }));
      view.dispatch({ effects: setRemoteCursors.of(safe) });
    });
  }
  destroy() { this.unsub(); }
});

export function remoteCursorsExtension() {
  return [remoteCursorField, broadcaster, subscriber];
}
