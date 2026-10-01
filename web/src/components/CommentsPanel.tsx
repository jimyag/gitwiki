import { useEffect, useRef, useState } from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../store";
import { api, type Comment, type CommentAnchor } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { btnPrimary } from "./ui";

// 页面评论。存到仓库的 .comments/<page>.json，不混进正文；不发即时持久化时，作者点“发送”后
// 先存在服务器内存里，只对本机可见，他之后点“保存评论”才真的提交。
export function CommentsPanel({ repo, pageId, body, onClose }: {
  repo: string;
  pageId: string;
  body: string; // current body for re-finding an anchor's position in the text
  onClose(): void;
}) {
  const user = useStore(s => s.user);
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

  return (
    <aside className="absolute right-0 inset-y-0 w-full sm:w-96 bg-white border-l border-stone-200 shadow-xl z-30 flex flex-col">
      <div className="h-12 shrink-0 px-4 flex items-center justify-between border-b border-stone-100">
        <div className="flex items-center gap-2 text-sm font-medium text-stone-900">
          <MessageSquare className="size-4 text-stone-400" />评论
          <button onClick={captureSelection} title="把当前选中的文字当作引用" className="text-xs text-emerald-700 hover:underline">引用所选</button>
        </div>
        <button onClick={onClose} className="text-xs text-stone-400 hover:text-stone-700">关闭</button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {items === null ? (
          <div className="text-sm text-stone-400 text-center py-8">加载中…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-stone-400 text-center py-8">还没有评论</div>
        ) : items.map(c => <Bubble key={c.id} c={c} body={body} mine={c.by === user?.login} />)}
      </div>
      {user ? (
        <form
          className="shrink-0 border-t border-stone-100 p-3 flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); void send(true); }}
        >
          {anchor && (
            <div className="text-xs text-amber-800 bg-amber-50 border-l-2 border-amber-400 px-2 py-1 rounded line-clamp-2 flex items-start gap-1">
              <span className="flex-1 truncate">{anchor.quote}</span>
              <button type="button" onClick={() => setAnchor(null)} className="text-amber-600 hover:underline shrink-0">移除</button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="说点什么。点上面的“引用所选”可以把选中的正文带进来。"
              className="flex-1 resize-none rounded-md border border-stone-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition"
            />
            <button type="submit" disabled={busy || !text.trim()} title="发送" className={`${btnPrimary} self-end`}>
              <SendHorizonal className="size-4" />
            </button>
          </div>
        </form>
      ) : (
        <div className="border-t border-stone-100 p-4 text-sm text-stone-400 text-center">登录后才能评论</div>
      )}
    </aside>
  );
}

function Bubble({ c, body, mine }: { c: Comment; body: string; mine: boolean }) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${mine ? "bg-emerald-50" : "bg-stone-50"}`}>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-medium text-stone-800 text-xs">{c.name || c.by}</span>
          <span className="text-[11px] text-stone-400" title={new Date(c.at).toLocaleString()}>
            {formatRelativeTime(c.at)}
          </span>
        </div>
        {c.anchor && (
          <AnchorPill anchor={c.anchor} body={body} />
        )}
        <div className="whitespace-pre-wrap leading-relaxed text-stone-800">{c.text}</div>
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
        (el as HTMLElement).classList.add("bg-amber-100");
        setTimeout(() => (el as HTMLElement).classList.remove("bg-amber-100"), 1600);
        return;
      }
    }
    toast.error("在当前显示的版本里看不到这段了");
  };
  return (
    <button
      onClick={jump}
      className="block mb-1.5 max-w-full text-left text-xs text-amber-800 bg-amber-50 border-l-2 border-amber-400 px-2 py-1 rounded truncate"
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
