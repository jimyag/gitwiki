import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X, type LucideIcon } from "lucide-react";

// Shared class names, so every bar, dialog and panel uses the same buttons and fields.
// Appending a utility for a property these already set (`${btnSecondary} h-7`) does not override
// it: Tailwind emits utilities in its own order, not the class string's, and .h-8 comes later.
const btn = "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap select-none transition-[background-color,color,box-shadow] disabled:opacity-40 disabled:pointer-events-none";
export const btnPrimary = `${btn} bg-ink text-ink-fg shadow-xs hover:bg-ink/85`;
export const btnSecondary = `${btn} bg-surface text-fg shadow-xs ring-1 ring-inset ring-line-strong/80 hover:bg-subtle`;
export const btnGhost = `${btn} text-fg-muted hover:bg-shade hover:text-fg`;
export const btnDanger = `${btn} bg-red-600 text-white shadow-xs hover:bg-red-700`;
export const iconBtn = "inline-flex items-center justify-center size-8 shrink-0 rounded-lg text-fg-muted transition-colors hover:bg-shade hover:text-fg disabled:opacity-30 disabled:pointer-events-none";
export const input = "w-full h-9 rounded-lg bg-surface px-3 text-sm text-fg ring-1 ring-inset ring-line-strong/80 outline-none transition-shadow placeholder:text-fg-subtle focus:ring-2 focus:ring-accent/60 disabled:opacity-60";
export const select = `${input} pr-8`; // room for the chevron index.css draws

// Small status pills in the top bar and lists.
const chip = "inline-flex items-center gap-1.5 h-7 shrink-0 px-2.5 rounded-full text-xs font-medium whitespace-nowrap";
export const chipNeutral = `${chip} bg-shade text-fg-muted`;
export const chipAmber = `${chip} bg-amber-500/10 text-amber-800 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300`;
export const chipRed = `${chip} bg-red-500/10 text-red-700 ring-1 ring-inset ring-red-500/25 dark:text-red-300`;

export const dialogTitle = "text-[15px] font-semibold text-fg";
export const dialogDesc = "mt-1 text-[13px] leading-relaxed text-fg-muted";
export const dialogFooter = "flex justify-end gap-2 px-5 pb-5 pt-1";

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
      className={`fixed inset-0 z-40 flex justify-center bg-stone-950/25 backdrop-blur-[3px] animate-fade-in dark:bg-black/55 ${center ? "items-center p-2 sm:p-6" : "items-start px-4 pt-[12vh]"}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" className={`w-full overflow-hidden rounded-2xl bg-raised shadow-pop animate-pop-in ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Header row of the bigger dialogs (lists, history, attachments): icon, title, a count or
// note, the dialog's own actions and the close button.
export function DialogHeader({ icon: Icon, title, meta, onClose, children }: {
  icon: LucideIcon;
  title: string;
  meta?: ReactNode;
  onClose(): void;
  children?: ReactNode;
}) {
  return (
    <div className="h-14 shrink-0 flex items-center gap-2.5 pl-5 pr-3 border-b border-line">
      <Icon className="size-4 shrink-0 text-fg-subtle" />
      <h2 className={dialogTitle}>{title}</h2>
      {meta && <span className="min-w-0 truncate text-xs text-fg-subtle">{meta}</span>}
      <div className="ml-auto flex items-center gap-1.5">
        {children}
        <button onClick={onClose} title="关闭" className={iconBtn}><X className="size-4" /></button>
      </div>
    </div>
  );
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

// Single-key shortcuts (E, /, ?) stay out of the way of typing, key combinations and anything
// open on top of the page.
export function shortcutBlocked(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || e.isComposing ||
    !!t?.closest("input, textarea, select, [contenteditable]") ||
    !!document.querySelector('[role="dialog"], [role="menu"]');
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-md bg-shade font-sans text-[11px] font-medium text-fg-muted">
      {children}
    </kbd>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?(): void;
  href?: string; // opens in a new tab instead
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean; // one of several choices: the chosen one shows a check mark
  className?: string; // e.g. "sm:hidden" for entries the bar already shows on wider screens
}
export type MenuEntry = MenuItem | "-";

// A button with a dropdown menu. Escape or a press elsewhere closes it.
export function Menu({ entries, label, buttonClass, children, up, align = "end", width = "w-56" }: {
  entries: MenuEntry[];
  label: string; // tooltip and accessible name of the button
  buttonClass: string;
  children: ReactNode; // what the button shows
  up?: boolean; // opens above the button (it sits at the bottom of the screen)
  align?: "start" | "end";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "w-full flex items-center gap-2.5 h-8 px-2 rounded-lg text-[13px] text-left transition-colors disabled:opacity-35 disabled:pointer-events-none [&>svg]:size-4 [&>svg]:shrink-0 ";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={buttonClass + (open ? " bg-shade text-fg" : "")}
      >
        {children}
      </button>
      {open && (
        <div
          role="menu"
          className={
            `absolute z-30 ${width} max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-xl bg-raised p-1 shadow-pop animate-pop-in ` +
            (up ? "bottom-full mb-1.5 " : "top-full mt-1.5 ") + (align === "end" ? "right-0" : "left-0")
          }
        >
          {entries.map((it, i) => {
            if (it === "-") return <div key={i} role="separator" className="mx-2 my-1 h-px bg-line" />;
            const cls = item + (it.danger
              ? "text-red-600 hover:bg-red-500/10 [&>svg]:text-red-500 dark:text-red-400 "
              : "text-fg-2 hover:bg-shade hover:text-fg [&>svg]:text-fg-subtle ") + (it.className ?? "");
            const body = <>{it.icon}<span className="flex-1 truncate">{it.label}</span>{it.checked && <Check className="size-3.5! text-accent-strong!" />}</>;
            return it.href ? (
              <a key={it.label} role="menuitem" href={it.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={cls}>
                {body}
              </a>
            ) : (
              <button
                key={it.label}
                role={it.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={it.checked}
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick?.(); }}
                className={cls}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
