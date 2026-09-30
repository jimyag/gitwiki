import { useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { githubLight } from "@uiw/codemirror-theme-github";
import { useStore } from "../store";
import { api, type ConflictResult } from "../lib/api";
import { connectPresence, disconnectPresence } from "../lib/ws";
import { toast } from "sonner";
import { X } from "lucide-react";
import { DiffView } from "./editor/DiffView";
import { remoteCursorsExtension } from "./editor/cursorOverlay";

interface LoadedPage {
  title: string;
  body: string;
  last_author?: string;
  last_commit_at?: string;
  last_commit_sha?: string;
}

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

  const [conflict, setConflict] = useState<ConflictResult | null>(null);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [titleInput, setTitleInput] = useState("");

  useEffect(() => {
    if (!currentRepo || !pageId) return;
    let cancelled = false;
    (async () => {
      const pc = await api.readPage(currentRepo, pageId);
      if (cancelled) return;
      setLoaded({
        title: pc.title,
        body: pc.body,
        last_author: pc.last_author,
        last_commit_at: pc.last_commit_at,
        last_commit_sha: pc.last_commit_sha,
      });
      setTitleInput(pc.title);
      useStore.getState().bumpBaseSha(pc.base_sha);
      connectPresence(currentRepo, pageId);
    })();
    return () => {
      cancelled = true;
      disconnectPresence();
    };
  }, [currentRepo, pageId]);

  useEffect(() => {
    if (!ref.current || loaded === null) return;
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
              try {
                const res = await api.uploadAsset(currentRepo, pageId, file);
                const ref = `![](${res.path})`;
                const pos = view.state.selection.main.head;
                view.dispatch({ changes: { from: pos, insert: ref } });
                toast.success(`已上传 ${file.name}`);
              } catch (e: any) {
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
  }, [loaded]);

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
          setLoaded(prev => prev ? { ...prev, last_author: pc.last_author, last_commit_at: pc.last_commit_at, last_commit_sha: pc.last_commit_sha } : null);
        }
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
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Close button in top-right corner (mostly there for keyboard; visual weight is low) */}
      <div className="absolute right-6 top-16 z-10">
        <button
          onClick={() => closePage()}
          title="关闭 (Cmd+W)"
          className="p-1.5 rounded-md text-stone-300 hover:text-stone-600 hover:bg-stone-100 transition"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <article className="max-w-[720px] mx-auto px-10 pt-12 pb-24">
          {/* Title */}
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
          {/* Body */}
          <div ref={ref} className="editor-body min-h-[50vh]" />
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
