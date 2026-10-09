import { useEffect, useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useCanWrite, useStore } from "../store";
import { api } from "../lib/api";
import { checkHealth, type HealthIssue } from "../lib/health";
import { Dialog, DialogHeader, btnSecondary, chipAmber } from "./ui";

const labels = { page: "失效页面链接", asset: "缺失图片或附件", anchor: "无效标题锚点", replacement: "无效替代页面", stale: "长期未更新" };

// Today in the reader's calendar, as Hugo writes dates.
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function HealthNotice() {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree);
  const baseSha = useStore(s => s.baseSha);
  const canWrite = useCanWrite();
  const [issues, setIssues] = useState<HealthIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [staleDays, setStaleDays] = useState(0);
  const [run, setRun] = useState(0);
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState(false);
  const onClose = () => setOpen(false);

  // A page that is still right needs no edit to leave the list: recording the review in its
  // front matter is a change, and so a commit, like any update.
  const stillRight = async (issue: HealthIssue) => {
    if (!repo) return;
    try {
      const pc = await api.readPage(repo, issue.page);
      const res = await api.savePage(repo, {
        id: issue.page, title: pc.title, body: pc.body, base_sha: pc.base_sha,
        meta: { ...pc.meta, reviewed: today() }, message: `wiki: review ${issue.page}`,
      });
      if ("conflict" in res) throw new Error("页面刚被别人修改过，请重新检查后再试");
      toast.success(`已确认「${issue.title}」内容仍然有效`);
      setRun(n => n + 1);
    } catch (e) {
      toast.error(`操作失败：${(e as Error).message}`);
    }
  };
  useEffect(() => {
    if (!repo || !tree) return;
    let live = true;
    setLoading(true);
    setError("");
    // Coalesce the tree refresh and the editor's updated commit after the same save.
    const timer = setTimeout(() => {
      api.health(repo).then(snapshot => {
        if (!live) return;
        const next = checkHealth(snapshot);
        setIssues(next);
        setCount(snapshot.pages.length);
        setStaleDays(snapshot.stale_days ?? 0);
        if (!next.length) setOpen(false);
      }).catch(e => { if (live) setError(e.message); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [repo, tree, baseSha, run]);
  const visible = issues.filter(i => !kind || i.kind === kind);

  if (!issues.length && !error) return null;

  return <>
    <button
      onClick={() => setOpen(true)}
      title={error ? `文档检查失败：${error}` : `发现 ${issues.length} 处文档问题，点击查看`}
      aria-label={error ? "文档检查失败，点击查看" : `发现 ${issues.length} 处文档问题，点击查看`}
      className={`${chipAmber} transition-colors hover:bg-amber-500/20`}
    >
      <AlertTriangle className="size-3.5" />
      <span className="hidden sm:inline">{error ? "检查失败" : "文档问题"}</span>
      {!error && <span className="tabular-nums">{issues.length}</span>}
    </button>
    {open && <Dialog center onClose={onClose} className="max-w-3xl">
      <DialogHeader icon={ShieldAlert} title="文档问题" meta={!loading && !error ? `已检查 ${count} 个页面，发现 ${issues.length} 处问题` : undefined} onClose={onClose}>
        <button className={btnSecondary} disabled={loading} onClick={() => setRun(n => n + 1)}>重新检查</button>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs text-fg-muted">
        <span className="flex-1 min-w-[16rem] leading-relaxed">
          检查已保存文档中的 Markdown 链接、图片、附件、标题锚点和替代页面{staleDays > 0 && `，以及超过 ${staleDays} 天没有更新的页面（草稿和已废弃的除外）`}。代码示例、外部网址、原始 HTML 和 Hugo 短代码不参与检查。
        </span>
        {!loading && !error && (
          <select aria-label="问题类型" value={kind} onChange={e => setKind(e.target.value)} className="h-8 rounded-lg bg-surface pl-2.5 pr-8 text-xs text-fg ring-1 ring-inset ring-line-strong/80 outline-none focus:ring-2 focus:ring-accent/60">
            <option value="">全部问题</option>
            {Object.entries(labels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
          </select>
        )}
      </div>
      {loading ? <p role="status" className="px-5 py-12 text-center text-sm text-fg-muted">正在检查文档…</p> : error ? (
        <p role="alert" className="px-5 py-8 text-sm text-red-600 dark:text-red-400">检查失败：{error}</p>
      ) : (
        <div className="max-h-[60vh] overflow-auto border-t border-line p-2">
          {visible.length === 0 && <p className="py-10 text-center text-sm text-fg-muted">此分类下没有问题</p>}
          {visible.map((issue, i) => {
            const stale = issue.kind === "stale";
            return (
              <div key={i} className="flex items-center gap-2 rounded-lg transition-colors hover:bg-shade">
                {/* A broken reference opens at its line (the editor, for writers); a stale page to read. */}
                <button className="min-w-0 flex-1 px-3 py-3 text-left" onClick={() => {
                  const st = useStore.getState();
                  if (!st.openPage(issue.page)) return;
                  if (!stale) st.requestLine(issue.line || 1);
                  onClose();
                }}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-fg">{issue.title}</span>
                    <span className="rounded-md bg-amber-500/10 px-1.5 text-xs text-amber-800 dark:text-amber-300">{labels[issue.kind]}</span>
                    {!stale && <span className="text-xs text-fg-subtle">{issue.line ? `正文第 ${issue.line} 行` : "页面属性"}</span>}
                  </div>
                  <p className="mt-1 break-all text-xs text-fg-muted">{issue.target}</p>
                  <p className={"mt-1 truncate text-xs text-fg-subtle" + (stale ? "" : " font-mono")}>{issue.excerpt}</p>
                </button>
                {stale && canWrite && (
                  <button className={`${btnSecondary} mr-3 shrink-0`} title="确认内容无需修改，记为今天复核过" onClick={() => void stillRight(issue)}>
                    内容仍有效
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>}
  </>;
}
