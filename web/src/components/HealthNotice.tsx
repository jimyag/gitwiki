import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { checkHealth, type HealthIssue } from "../lib/health";
import { Dialog, btnOutline } from "./ui";

const labels = { page: "失效页面链接", asset: "缺失图片或附件", anchor: "无效标题锚点", replacement: "无效替代页面" };

export default function HealthNotice() {
  const repo = useStore(s => s.currentRepo);
  const tree = useStore(s => s.tree);
  const baseSha = useStore(s => s.baseSha);
  const [issues, setIssues] = useState<HealthIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [run, setRun] = useState(0);
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState(false);
  const onClose = () => setOpen(false);
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
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 text-xs text-amber-800 hover:bg-amber-100"
    >
      <AlertTriangle className="size-3.5" />
      <span className="hidden sm:inline">{error ? "检查失败" : "文档问题"}</span>
      {!error && <span>{issues.length}</span>}
    </button>
    {open && <Dialog center onClose={onClose} className="max-w-3xl">
    <div className="flex items-center gap-3 border-b border-stone-200 px-5 py-4">
      <h2 className="flex-1 text-sm font-semibold">文档问题</h2>
      <button className={btnOutline} disabled={loading} onClick={() => setRun(n => n + 1)}>重新检查</button>
      <button title="关闭" onClick={onClose}><X className="size-4 text-stone-500" /></button>
    </div>
    <div className="px-5 py-3 text-xs text-stone-500">
      检查已保存文档中的 Markdown 链接、图片、附件、标题锚点和替代页面。代码示例、外部网址、原始 HTML 和 Hugo 短代码不参与检查。
    </div>
    {loading ? <p role="status" className="px-5 py-12 text-sm text-stone-500">正在检查文档…</p> : error ? (
      <p role="alert" className="px-5 py-8 text-sm text-red-600">检查失败：{error}</p>
    ) : <>
      <div className="flex flex-wrap items-center gap-3 px-5 pb-3 text-sm text-stone-600">
        <span>已检查 {count} 个页面，发现 {issues.length} 处问题</span>
        <select aria-label="问题类型" value={kind} onChange={e => setKind(e.target.value)} className="rounded border border-stone-200 bg-white p-1.5 text-xs">
          <option value="">全部问题</option>
          {Object.entries(labels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
        </select>
      </div>
      <div className="max-h-[60vh] overflow-auto border-t border-stone-100 p-2">
        {visible.length === 0 && <p className="py-10 text-center text-sm text-stone-500">此分类下没有问题</p>}
        {visible.map((issue, i) => <button key={i} className="block w-full rounded-lg px-3 py-3 text-left hover:bg-stone-50" onClick={() => {
          const st = useStore.getState();
          if (st.openPage(issue.page)) { st.requestLine(issue.line || 1); onClose(); }
        }}>
          <div className="flex flex-wrap gap-2 text-sm"><span className="font-medium text-stone-900">{issue.title}</span><span className="text-amber-800">{labels[issue.kind]}</span><span className="text-xs text-stone-400">{issue.line ? `正文第 ${issue.line} 行` : "页面属性"}</span></div>
          <p className="mt-1 break-all text-xs text-stone-600">{issue.target}</p>
          <p className="mt-1 truncate font-mono text-xs text-stone-400">{issue.excerpt}</p>
        </button>)}
      </div>
    </>}
    </Dialog>}
  </>;
}
