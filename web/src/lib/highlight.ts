// Code block highlighting for the reading view: Shiki (VS Code grammars and themes), loaded on
// first use with the JavaScript regex engine (no WASM), and only the grammars a page needs.
import type { HighlighterCore } from "shiki/core";

type Grammar = () => Promise<{ default: any }>;

// Curated so the build does not ship all ~200 grammars; other fences render as plain text.
const grammars: Record<string, Grammar> = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const aliases: Record<string, string> = {
  sh: "bash", shell: "bash", shellscript: "bash", zsh: "bash", console: "bash",
  "c++": "cpp", dockerfile: "docker", golang: "go", js: "javascript", jsonc: "json",
  make: "makefile", md: "markdown", py: "python", rs: "rust", ts: "typescript", yml: "yaml",
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

// highlight returns the code as themed HTML (one span.line per line), or null for languages
// it does not know, in which case the caller shows plain text.
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const key = lang?.toLowerCase() ?? "";
  const name = aliases[key] ?? key;
  const grammar = grammars[name];
  if (!grammar) return null;
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
    ]);
    return createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  const hl = await highlighter;
  if (!loaded.has(name)) loaded.set(name, grammar().then(m => hl.loadLanguage(m.default)));
  await loaded.get(name);
  return hl.codeToHtml(code, { lang: name, theme: "github-light" });
}
