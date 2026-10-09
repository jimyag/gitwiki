import { useSyncExternalStore } from "react";

// Light, dark or the system's choice, kept in this browser only. index.html applies the same
// rule before the first paint, so a dark page never flashes white.
export type ThemePref = "light" | "dark" | "system";

const KEY = "gitwiki.theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply() {
  const p = themePref();
  document.documentElement.classList.toggle("dark", p === "dark" || (p === "system" && media.matches));
  listeners.forEach(l => l());
}

export function setThemePref(p: ThemePref) {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {}
  apply();
}

media.addEventListener("change", apply);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export const useThemePref = () => useSyncExternalStore(subscribe, themePref);
// Whether the page is dark right now, for the parts that cannot follow CSS variables
// (Mermaid diagrams, the toaster, the editor's own theme switch).
export const useDark = () => useSyncExternalStore(subscribe, () => document.documentElement.classList.contains("dark"));
