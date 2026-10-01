import { useEffect, useId, useState } from "react";

type MermaidAPI = typeof import("mermaid").default;

// Mermaid is the largest dependency by far: fetched the first time a page has a diagram.
let loading: Promise<MermaidAPI> | null = null;
function loadMermaid() {
  return (loading ??= import("mermaid").then(({ default: m }) => {
    // strict: labels are sanitized and click handlers / scripts in diagrams are disabled.
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "inherit" });
    return m;
  }));
}

// A ```mermaid code block drawn as a diagram, as Hugo themes with mermaid support do. If the
// diagram does not parse, the source is shown with the error.
export function Mermaid({ code, fallback }: { code: string; fallback: React.ReactNode }) {
  const id = "mermaid-" + useId().replace(/[^\w-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    loadMermaid()
      .then(m => m.render(id, code))
      .then(r => { if (live) setSvg(r.svg); })
      .catch((e: unknown) => {
        document.getElementById("d" + id)?.remove(); // the scratch element a failed render leaves behind
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { live = false; };
  }, [id, code]);

  if (error) {
    return (
      <div>
        {fallback}
        <p className="-mt-3 mb-5 text-xs text-red-600 whitespace-pre-wrap">Mermaid 图表有误：{error}</p>
      </div>
    );
  }
  if (!svg) return <div className="my-5 h-40 rounded-lg border border-stone-200 bg-stone-50 animate-pulse" aria-label="图表加载中" />;
  return (
    <div
      className="my-5 flex justify-center overflow-x-auto rounded-lg border border-stone-200 p-4 [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
