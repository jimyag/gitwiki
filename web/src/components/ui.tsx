import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Shared class names so the TopBar and the page actions Editor portals into it look like one bar.
// Appending a utility for a property these already set (`${btnOutline} h-7`) does not override
// it: Tailwind emits utilities in its own order, not the class string's, and .h-8 comes later.
const btn = "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[13px] font-medium whitespace-nowrap transition disabled:opacity-40 disabled:pointer-events-none";
export const btnGhost = `${btn} text-stone-600 hover:bg-stone-100 hover:text-stone-900`;
export const btnOutline = `${btn} border border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50`;
export const btnPrimary = `${btn} bg-emerald-600 text-white shadow-sm hover:bg-emerald-700`;
export const btnDanger = `${btn} bg-red-600 text-white shadow-sm hover:bg-red-700`;
export const iconBtn = "inline-flex items-center justify-center size-8 shrink-0 rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-30 disabled:pointer-events-none";
export const input = "w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20";
export const dialogFooter = "flex justify-end gap-2 px-5 py-3 bg-stone-50 border-t border-stone-100";

// Modal shell, portaled to <body>: the sidebar drawer is transformed, which would otherwise trap
// position:fixed. Escape or a press outside closes it. Clicks stop here, because through the
// portal they would still bubble to the React parents (a tree row would open its page).
export function Dialog({ onClose, center, className = "max-w-sm", children }: {
  onClose(): void;
  center?: boolean; // big panels; forms and pickers sit high so their lists grow downward
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className={`fixed inset-0 z-40 flex justify-center bg-stone-900/25 backdrop-blur-[2px] ${center ? "items-center p-2 sm:p-6" : "items-start px-4 pt-[12vh]"}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" className={`w-full overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-stone-900/5 ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Stable color from user login. Used in avatar and cursor.
export function colorForUser(login: string): string {
  const palette = [
    ["#0ea5e9", "#0284c7"], // sky
    ["#8b5cf6", "#7c3aed"], // violet
    ["#f59e0b", "#d97706"], // amber
    ["#10b981", "#059669"], // emerald
    ["#ef4444", "#dc2626"], // red
    ["#ec4899", "#db2777"], // pink
    ["#14b8a6", "#0d9488"], // teal
    ["#f97316", "#ea580c"], // orange
  ];
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function Avatar({ login, name, className = "size-6 text-[10px]" }: { login: string; name?: string; className?: string }) {
  const src = `https://github.com/${encodeURIComponent(login)}.png?size=64`;
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white ${className}`}
      style={{ background: colorForUser(login) }}
      title={name || login}
    >
      {login.slice(0, 1).toUpperCase()}
      {src !== failedSrc && (
        <img src={src} alt={`${name || login} 的头像`} className="absolute inset-0 size-full object-cover" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
      )}
    </span>
  );
}
