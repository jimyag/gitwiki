import { useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { githubLight } from "@uiw/codemirror-theme-github";
import { useStore } from "../store";
import { api, type ConflictResult, type PageContent } from "../lib/api";
import { connectPresence, disconnectPresence } from "../lib/ws";
import { toast } from "sonner";
import { X, Paperclip, Pencil, Eye, Save } from "lucide-react";
import { DiffView } from "./editor/DiffView";
import { AssetsPanel } from "./AssetsPanel";
import { Preview } from "./Preview";
import { remoteCursorsExtension } from "./editor/cursorOverlay";

interface LoadedPage {
  title: string;
  body: string;
  last_author?: string;
  last_commit_at?: string;
  last_commit_sha?: string;
}

type Mode = "view" | "edit";

export function Editor() {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const baseSha = useStore(s => s.baseSha);
  const setSaveStatus = useStore(s => s.setSaveStatus);
  const markDirty = useStore(s => s.markDirty);
  const bumpBaseSha = useStore(s => s.bumpBaseSha);
  const closePage = useStore(s => s.closePage);
  const saveStatus = useStore(s => s.saveStatus);

  const [mode, setMode] = useState<Mode>("view");
  const [conflict, setConflict] = useState<ConflictResult | null>(null);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [showAssets, setShowAssets] = useState(false);
  // Bump to force CodeMirror re-init when entering edit mode with loaded body.

  useEffect(() => {
    if (!currentRepo || !pageId) return;
    let cancelled = false;
    setMode("view"); // opening a page → default to preview
    (async () => {
      const pc = await api.readPage(currentRepo, pageId);
      if (cancelled) return;
      applyLoaded(pc);
      connectPresence(currentRepo, pageId);
    })();
    return () => {
      cancelled = true;
      disconnectPresence();
    };
  }, [currentRepo, pageId]);

  function applyLoaded(pc: PageContent) {
    setLoaded({
      title: pc.title,
      body: pc.body,
      last_author: pc.last_author,
      last_commit_at: pc.last_commit_at,
      last_commit_sha: pc.last_commit_sha,
    });
    setTitleInput(pc.title);
    useStore.getState().bumpBaseSha(pc.base_sha);
    markDirty(false);
  }

  // Cmd+S / Ctrl+S global handler when in edit mode.
  useEffect(() => {
    if (mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (mode !== "edit" || !ref.current || loaded === null) return;
    const updateListener = EditorView.updateListener.of(u => {
      if (u.docChanged) markDirty(true);
    });
    const pasteHandler = EditorView.domEventHandlers({
      paste: (event, view) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            if (!currentRepo || !pageId) return true;
            (async () => {
              const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              useStore.getState().addUpload({ id, filename: file.name, pct: 0, status: "uploading" });
              try {
                const res = await api.uploadAsset(currentRepo, pageId, file, (pct) => {
                  useStore.getState().updateUpload(id, { pct });
                });
                useStore.getState().updateUpload(id, { pct: 100, status: "done" });
                setTimeout(() => useStore.getState().removeUpload(id), 2500);
                const ref = `![](${res.path})`;
                const pos = view.state.selection.main.head;
                view.dispatch({ changes: { from: pos, insert: ref } });
              } catch (e: any) {
                useStore.getState().updateUpload(id, { status: "error", error: e.message });
                toast.error(`上传失败: ${e.message}`);
              }
            })();
            return true;
          }
        }
        return false;
      },
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: loaded.body,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, {
            key: "Mod-s",
            run: () => { void doSave(); return true; },
          }]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(defaultHighlightStyle),
          githubLight,
          placeholder("开始写正文"),
          updateListener,
          pasteHandler,
          remoteCursorsExtension(),
          EditorView.lineWrapping,
        ],
      }),
      parent: ref.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [mode, loaded?.body]);

  async function doSave() {
    if (!currentRepo || !pageId || !viewRef.current) return;
    const body = viewRef.current.state.doc.toString();
    setSaveStatus("saving");
    try {
      const sha = conflict?.current_sha ?? baseSha;
      const res = await api.savePage(currentRepo, {
        id: pageId,
        title: titleInput.trim() || "未命名",
        body,
        base_sha: sha,
      });
      if ("conflict" in res && res.conflict) {
        setConflict(res as ConflictResult);
        setSaveStatus("conflict");
        return;
      }
      if ("commit_sha" in res) {
        bumpBaseSha(res.commit_sha);
        markDirty(false);
        setSaveStatus("saved");
        setConflict(null);
        setTimeout(() => setSaveStatus("idle"), 1500);
        if (currentRepo && pageId) {
          const pc = await api.readPage(currentRepo, pageId);
          applyLoaded(pc);
          // reflect new body in editor
          if (viewRef.current) {
            viewRef.current.dispatch({
              changes: { from: 0, to: viewRef.current.state.doc.length, insert: pc.body },
            });
          }
        }
        setMode("view");
      }
    } catch (e: any) {
      setSaveStatus("error");
      toast.error(`保存失败: ${e.message}`);
    }
  }

  if (!currentRepo || !pageId) return null;
  if (conflict) {
    return (
      <DiffView
        theirsBody={conflict.theirs_body}
        oursBody={conflict.ours_body}
        mergedWholeText={conflict.merged}
        onApplyMergedBody={(body) => {
          if (viewRef.current) {
            viewRef.current.dispatch({
              changes: { from: 0, to: viewRef.current.state.doc.length, insert: body },
            });
          }
          if (conflict.current_sha) bumpBaseSha(conflict.current_sha);
          setConflict(null);
          setSaveStatus("idle");
          toast.info("已载入合并结果,请检查后再次保存");
        }}
        onDismiss={() => setConflict(null)}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Toolbar */}
      <div className="absolute right-6 top-4 z-10 flex items-center gap-1 bg-white rounded-md shadow-sm border border-stone-200 p-0.5">
        <button
          onClick={() => mode === "view" ? setMode("edit") : setMode("view")}
          title={mode === "edit" ? "切换到预览" : "编辑 (E)"}
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition"
        >
          {mode === "edit" ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
          {mode === "edit" ? "预览" : "编辑"}
        </button>
        {mode === "edit" && (
          <button
            onClick={() => void doSave()}
            disabled={saveStatus === "saving"}
            title="保存 (⌘S)"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
          >
            <Save className="size-3.5" />
            保存
          </button>
        )}
        <button
          onClick={() => setShowAssets(true)}
          title="附件"
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition"
        >
          <Paperclip className="size-3.5" />
        </button>
        <button
          onClick={() => closePage()}
          title="关闭"
          className="inline-flex items-center px-2 py-1.5 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {showAssets && <AssetsPanel onClose={() => setShowAssets(false)} />}

      <div className="flex-1 overflow-auto">
        <article className="max-w-[720px] mx-auto px-10 pt-12 pb-24">
          {/* Title */}
          {mode === "edit" ? (
            <input
              value={titleInput}
              onChange={(e) => {
                setTitleInput(e.target.value);
                markDirty(true);
              }}
              placeholder="未命名页面"
              className="w-full text-[38px] font-bold tracking-tight outline-none placeholder:text-stone-300 text-stone-900 bg-transparent leading-[1.2] mb-6 pb-4 border-b border-transparent focus:border-stone-100 transition"
              style={{ fontFamily: '"Source Serif 4", Georgia, "Songti SC", serif' }}
            />
          ) : (
            <h1
              className="text-[38px] font-bold tracking-tight text-stone-900 leading-[1.2] mb-6 pb-4 border-b border-stone-100"
              style={{ fontFamily: '"Source Serif 4", Georgia, "Songti SC", serif' }}
            >
              {titleInput || "未命名页面"}
            </h1>
          )}

          {/* Body */}
          {mode === "edit" ? (
            <div ref={ref} className="editor-body min-h-[50vh]" />
          ) : (
            <Preview body={loaded?.body ?? ""} />
          )}

          {/* Footer meta */}
          {loaded?.last_author && (
            <div className="mt-12 pt-4 border-t border-stone-100 text-xs text-stone-400 flex items-center gap-2">
              <span>最后由 <span className="font-medium text-stone-600">{loaded.last_author}</span> 编辑</span>
              <span className="text-stone-300">·</span>
              <span>{formatRelativeTime(loaded.last_commit_at)}</span>
              {loaded.last_commit_sha && (
                <>
                  <span className="text-stone-300">·</span>
                  <code className="font-mono text-[11px] text-stone-400 bg-stone-50 px-1.5 py-0.5 rounded">{loaded.last_commit_sha.slice(0, 7)}</code>
                </>
              )}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}
