import { useState } from "react";
import { ArrowRight, X } from "lucide-react";

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
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      <div className="border-b border-neutral-200 bg-amber-50/50 px-4 py-2.5 flex items-center gap-3">
        <div className="text-xs font-medium text-amber-900">该页面被他人更新，存在冲突</div>
        <div className="flex items-center gap-0.5 bg-white rounded-md p-0.5 border border-neutral-200">
          <Tab active={tab === "side"} onClick={() => setTab("side")}>并排对比</Tab>
          <Tab active={tab === "merged"} onClick={() => setTab("merged")}>自动合并结果</Tab>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => onApplyMergedBody(mergedBody)}
          className="inline-flex items-center gap-1 rounded-md bg-amber-600 text-white px-2.5 py-1 text-xs font-medium hover:bg-amber-700"
        >
          以合并结果继续编辑 <ArrowRight className="size-3" />
        </button>
        <button onClick={onDismiss} className="p-1 rounded text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100">
          <X className="size-4" />
        </button>
      </div>
      {tab === "side" ? (
        <SideBySide theirs={theirsBody} ours={oursBody} />
      ) : (
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono bg-neutral-50 text-neutral-800 whitespace-pre-wrap">{mergedBody}</pre>
      )}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-2.5 py-1 rounded text-xs font-medium transition " +
        (active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100")
      }
    >
      {children}
    </button>
  );
}

function SideBySide({ theirs, ours }: { theirs: string; ours: string }) {
  const diff = computeLineDiff(theirs, ours);
  return (
    <div className="flex-1 overflow-auto grid grid-cols-2 divide-x divide-neutral-200">
      <div className="p-4">
        <div className="text-[10px] uppercase font-semibold tracking-wider text-neutral-400 mb-2">他人已保存</div>
        <DiffColumn lines={diff.theirs} side="theirs" />
      </div>
      <div className="p-4">
        <div className="text-[10px] uppercase font-semibold tracking-wider text-neutral-400 mb-2">你的版本</div>
        <DiffColumn lines={diff.ours} side="ours" />
      </div>
    </div>
  );
}

function DiffColumn({ lines, side }: { lines: Array<{ text: string; kind: "same" | "add" | "del" | "blank" }>; side: "theirs" | "ours" }) {
  return (
    <div className="font-mono text-xs space-y-px">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            "px-1.5 rounded-sm whitespace-pre-wrap break-all min-h-[1.25rem] " +
            (l.kind === "same" || l.kind === "blank" ? "text-neutral-700" :
             l.kind === "add" ? (side === "ours" ? "bg-emerald-50 text-emerald-900" : "text-neutral-700") :
             (side === "theirs" ? "bg-red-50 text-red-900 line-through opacity-70" : "text-neutral-700"))
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
