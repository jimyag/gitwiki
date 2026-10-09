import { useState } from "react";
import { AlertTriangle, ArrowRight, X } from "lucide-react";

interface Props {
  theirsBody: string;
  oursBody: string;
  mergedWholeText: string; // includes front matter + conflict markers
  onApplyMergedBody: (body: string) => void;
  onDismiss: () => void;
}

export function DiffView({ theirsBody, oursBody, mergedWholeText, onApplyMergedBody, onDismiss }: Props) {
  const [tab, setTab] = useState<"side" | "merged">("side");

  // Pull body out of merged text (strip front matter portion)
  const m = mergedWholeText.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const mergedBody = m ? m[1] : mergedWholeText;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-amber-500/10 px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle className="size-4" />该页面被他人更新，存在冲突
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-shade p-0.5">
          <Tab active={tab === "side"} onClick={() => setTab("side")}>并排对比</Tab>
          <Tab active={tab === "merged"} onClick={() => setTab("merged")}>自动合并结果</Tab>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => onApplyMergedBody(mergedBody)}
          className="inline-flex items-center gap-1.5 h-8 rounded-lg bg-amber-600 px-3 text-[13px] font-medium text-white shadow-xs transition-colors hover:bg-amber-700"
        >
          以合并结果继续编辑 <ArrowRight className="size-3.5" />
        </button>
        <button onClick={onDismiss} title="关闭" className="inline-flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-shade hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      {tab === "side" ? (
        <SideBySide theirs={theirsBody} ours={oursBody} />
      ) : (
        <pre className="flex-1 overflow-auto bg-subtle p-4 font-mono text-xs leading-relaxed text-fg-2 whitespace-pre-wrap">{mergedBody}</pre>
      )}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "h-7 px-2.5 rounded-md text-xs font-medium transition-colors " +
        (active ? "bg-raised text-fg shadow-xs" : "text-fg-muted hover:text-fg")
      }
    >
      {children}
    </button>
  );
}

// SideBySide shows two versions with removed lines struck on the left and added lines marked
// on the right. Also used by the page history.
export function SideBySide({ theirs, ours, theirsLabel = "他人已保存", oursLabel = "你的版本" }: {
  theirs: string; ours: string; theirsLabel?: string; oursLabel?: string;
}) {
  const diff = computeLineDiff(theirs, ours);
  return (
    <div className="flex-1 overflow-auto grid grid-cols-2 divide-x divide-line">
      <div className="p-4 min-w-0">
        <div className="text-[11px] font-semibold text-fg-subtle mb-2">{theirsLabel}</div>
        <DiffColumn lines={diff.theirs} side="theirs" />
      </div>
      <div className="p-4 min-w-0">
        <div className="text-[11px] font-semibold text-fg-subtle mb-2">{oursLabel}</div>
        <DiffColumn lines={diff.ours} side="ours" />
      </div>
    </div>
  );
}

function DiffColumn({ lines, side }: { lines: Array<{ text: string; kind: "same" | "add" | "del" | "blank" }>; side: "theirs" | "ours" }) {
  return (
    <div className="font-mono text-xs leading-relaxed space-y-px">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            "px-1.5 rounded-sm whitespace-pre-wrap break-all min-h-[1.25rem] " +
            (l.kind === "same" || l.kind === "blank" ? "text-fg-2" :
             l.kind === "add" ? (side === "ours" ? "bg-emerald-500/12 text-emerald-900 dark:text-emerald-200" : "text-fg-2") :
             (side === "theirs" ? "bg-red-500/10 text-red-900 line-through opacity-75 dark:text-red-200" : "text-fg-2"))
          }
        >
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}

interface DiffLine { text: string; kind: "same" | "add" | "del" | "blank" }
interface DiffResult { theirs: DiffLine[]; ours: DiffLine[] }

// Common-prefix/suffix based diff. Falls back to whole-text differ in worst case.
// ponytail: O(n*m) is fine; pages are <10K lines. Switch to Myers if people write novels.
function computeLineDiff(theirs: string, ours: string): DiffResult {
  const a = theirs.split("\n");
  const b = ours.split("\n");
  const m = a.length, n = b.length;
  // LCS via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const outA: DiffLine[] = [];
  const outB: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      outA.push({ text: a[i], kind: "same" });
      outB.push({ text: b[j], kind: "same" });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      outA.push({ text: a[i], kind: "del" });
      outB.push({ text: "", kind: "blank" });
      i++;
    } else {
      outA.push({ text: "", kind: "blank" });
      outB.push({ text: b[j], kind: "add" });
      j++;
    }
  }
  while (i < m) { outA.push({ text: a[i], kind: "del" }); outB.push({ text: "", kind: "blank" }); i++; }
  while (j < n) { outA.push({ text: "", kind: "blank" }); outB.push({ text: b[j], kind: "add" }); j++; }
  return { theirs: outA, ours: outB };
}
