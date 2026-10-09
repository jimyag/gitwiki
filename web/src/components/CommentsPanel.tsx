import { useEffect, useRef, useState } from "react";
import { MessageSquare, TextQuote, X } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../store";
import { api, type Comment, type CommentAnchor } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { Avatar, btnPrimary, iconBtn } from "./ui";

// 页面评论。存到仓库的 .comments/<page>.json，不混进正文；不发即时持久化时，作者点“发送”后
// 先存在服务器内存里，只对本机可见，他之后点“保存评论”才真的提交。
export function CommentsPanel({ repo, pageId, body, onClose }: {
  repo: string;
  pageId: string;
  body: string; // current body for re-finding an anchor's position in the text
  onClose(): void;
}) {
  const commentsRev = useStore(s => s.commentsRev);
  const [items, setItems] = useState<Comment[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.comments(repo, pageId).then(setItems, () => setItems([]));
  }, [repo, pageId, commentsRev]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items?.length]);

  // 选中正文里的一段文字（在阅读模式里），进来的时候它成为评论的引用。
  const captureSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const quote = sel.toString();
    if (!quote || quote.length > 400) return;
    setAnchor({
      quote,
      prefix: "",
      suffix: "",
      start_raw: -1,
      end_raw: -1,
    });
  };

  const send = async (save: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.postComment(repo, { page_id: pageId, text: trimmed, anchor: anchor ?? undefined, save });
      setText("");
      setAnchor(null);
      setItems(await api.comments(repo, pageId));
    } catch (e) {
      toast.error(`发送失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Phones: a full-screen sheet. From sm up: a column docked next to the page.
  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-surface animate-fade-in sm:animate-none sm:static sm:z-auto sm:w-80 xl:w-96 sm:shrink-0 sm:border-l sm:border-line">
      <div className="h-12 shrink-0 flex items-center gap-2 pl-4 pr-2 border-b border-line">
        <MessageSquare className="size-4 text-fg-subtle" />
        <h2 className="text-sm font-semibold text-fg">评论</h2>
        {!!items?.length && <span className="rounded-full bg-shade px-1.5 text-xs tabular-nums text-fg-muted">{items.length}</span>}
        <button onClick={onClose} title="关闭" className={`${iconBtn} ml-auto`}><X className="size-4" /></button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
        {items === null ? (
          <div className="text-sm text-fg-muted text-center py-8">加载中…</div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-subtle ring-1 ring-line">
              <MessageSquare className="size-4 text-fg-subtle" />
            </div>
            <p className="mt-3 text-sm font-medium text-fg">还没有评论</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">在正文里选中一段文字，再点“引用所选”，评论会带上这段引用</p>
          </div>
        ) : items.map(c => <CommentItem key={c.id} c={c} body={body} />)}
      </div>
      <form className="shrink-0 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(true); }}>
        {anchor && (
          <div className="mb-2 flex items-start gap-2 rounded-r-lg border-l-2 border-amber-400 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200">
            <span className="flex-1 line-clamp-2">{anchor.quote}</span>
            <button type="button" onClick={() => setAnchor(null)} className="shrink-0 hover:underline">移除</button>
          </div>
        )}
        <div className="rounded-xl bg-surface ring-1 ring-inset ring-line-strong/80 transition-shadow focus-within:ring-2 focus-within:ring-accent/60">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="写评论…"
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle"
          />
          <div className="flex items-center gap-2 p-1.5">
            <button
              type="button"
              onClick={captureSelection}
              title="先在正文里选中一段，再点这里，评论会带上这段引用"
              className="inline-flex items-center gap-1 h-7 px-2 rounded-lg text-xs text-fg-muted transition-colors hover:bg-shade hover:text-fg"
            >
              <TextQuote className="size-3.5" />引用所选
            </button>
            <button type="submit" disabled={busy || !text.trim()} className={`${btnPrimary} ml-auto`}>发送</button>
          </div>
        </div>
      </form>
    </aside>
  );
}

function CommentItem({ c, body }: { c: Comment; body: string }) {
  return (
    <div className="flex gap-2.5">
      <Avatar login={c.by} name={c.name} className="size-7 text-[11px] mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-fg truncate">{c.name || c.by}</span>
          <span className="shrink-0 text-xs text-fg-subtle" title={new Date(c.at).toLocaleString()}>{formatRelativeTime(c.at)}</span>
        </div>
        {c.anchor && <AnchorPill anchor={c.anchor} body={body} />}
        <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-fg-2">{c.text}</div>
      </div>
    </div>
  );
}

// 评论带的原文片段。位置可能已经不在原处：按 prefix+quote+suffix 重找，找到了能够滚过去。
function AnchorPill({ anchor, body }: { anchor: CommentAnchor; body: string }) {
  const jump = () => {
    const i = findAnchor(body, anchor);
    if (i < 0) {
      toast.error("正文中找不到这段了");
      return;
    }
    // Rendered preview doesn't mirror raw offsets; fall back to a rough search on the
    // visible text, which is good enough for a jump.
    const probe = anchor.quote.slice(0, 40);
    const all = document.querySelectorAll("article *");
    for (const el of all) {
      if (el.textContent?.includes(probe)) {
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement).classList.add("bg-amber-500/20");
        setTimeout(() => (el as HTMLElement).classList.remove("bg-amber-500/20"), 1600);
        return;
      }
    }
    toast.error("在当前显示的版本里看不到这段了");
  };
  return (
    <button
      onClick={jump}
      className="block mt-1.5 mb-1 max-w-full truncate rounded-r-lg border-l-2 border-amber-400 bg-amber-500/10 px-2 py-1 text-left text-xs text-fg-muted transition-colors hover:bg-amber-500/15"
      title="跳到原文"
    >
      {anchor.quote}
    </button>
  );
}

// 找到 anchor 在当前 body 里的开始下标，找不到返回 -1。
export function findAnchor(body: string, a: CommentAnchor): number {
  for (let i = 0; i <= body.length - a.quote.length; i++) {
    if (body.startsWith(a.quote, i) &&
        body.startsWith(a.prefix, Math.max(0, i - a.prefix.length)) &&
        body.startsWith(a.suffix, i + a.quote.length)) {
      return i;
    }
  }
  return -1;
}
