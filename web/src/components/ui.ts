// Shared class names so the TopBar and the page actions Editor portals into it look like one bar.
const btn = "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[13px] font-medium whitespace-nowrap transition disabled:opacity-40 disabled:pointer-events-none";
export const btnGhost = `${btn} text-stone-600 hover:bg-stone-100 hover:text-stone-900`;
export const btnOutline = `${btn} border border-stone-200 text-stone-700 hover:border-stone-300 hover:bg-stone-50`;
export const btnPrimary = `${btn} bg-emerald-600 text-white shadow-sm hover:bg-emerald-700`;
export const iconBtn = "inline-flex items-center justify-center size-8 shrink-0 rounded-md text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 disabled:opacity-30 disabled:pointer-events-none";
// Backdrop for modal dialogs.
export const overlay = "fixed inset-0 z-40 bg-stone-900/25 backdrop-blur-[2px]";
