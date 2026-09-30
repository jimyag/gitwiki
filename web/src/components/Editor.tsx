import { useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { githubLight } from "@uiw/codemirror-theme-github";
import { useStore } from "../store";
import { api } from "../lib/api";
import { connectPresence, disconnectPresence } from "../lib/ws";
import { toast } from "sonner";
import { Save, RefreshCw, X } from "lucide-react";

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

  const [conflictMerged, setConflictMerged] = useState<string | null>(null);
  const [conflictSha, setConflictSha] = useState<string | null>(null);
  const [loadedContent, setLoadedContent] = useState<string | null>(null);

  // Load page content & connect presence.
  useEffect(() => {
    if (!currentRepo || !pageId) return;
    let cancelled = false;
    (async () => {
      const pc = await api.readPage(currentRepo, pageId);
      if (cancelled) return;
      setLoadedContent(pc.content);
      useStore.getState().bumpBaseSha(pc.base_sha);
      connectPresence(currentRepo, pageId);
    })();
    return () => {
      cancelled = true;
      disconnectPresence();
    };
  }, [currentRepo, pageId]);

  // Init CodeMirror once content is loaded.
  useEffect(() => {
    if (!ref.current || loadedContent === null) return;
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
        doc: loadedContent,
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
          placeholder("开始写…"),
          updateListener,
          pasteHandler,
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
  }, [loadedContent]);

  async function doSave() {
    if (!currentRepo || !pageId || !viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    setSaveStatus("saving");
    try {
      const sha = conflictSha ?? baseSha;
      const res = await api.savePage(currentRepo, { id: pageId, content, base_sha: sha });
      if ("conflict" in res && res.conflict) {
        setConflictMerged(res.merged);
        setConflictSha(res.current_sha);
        setSaveStatus("conflict");
        return;
      }
      if ("commit_sha" in res) {
        bumpBaseSha(res.commit_sha);
        markDirty(false);
        setSaveStatus("saved");
        setConflictMerged(null);
        setConflictSha(null);
        setTimeout(() => setSaveStatus("idle"), 1500);
      }
    } catch (e: any) {
      setSaveStatus("error");
      toast.error(`保存失败: ${e.message}`);
    }
  }

  function applyConflictAndSave() {
    if (!viewRef.current || conflictMerged === null) return;
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: conflictMerged },
    });
    if (conflictSha) bumpBaseSha(conflictSha);
    setConflictMerged(null);
    // Note: we do NOT auto-save; let the user resolve conflict markers then press save.
    toast.info("冲突内容已并入编辑器，请手动解决冲突标记后再保存");
  }

  if (!currentRepo || !pageId) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-neutral-200 bg-white px-4 py-2 flex items-center gap-2 text-sm">
        <div className="text-neutral-500 font-mono text-xs">{pageId}</div>
        <div className="flex-1" />
        <button
          onClick={() => void doSave()}
          disabled={saveStatus === "saving"}
          className="inline-flex items-center gap-1 rounded-md bg-neutral-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {saveStatus === "saving" ? <RefreshCw className="size-3 animate-spin" /> : <Save className="size-3" />}
          保存
        </button>
        <button
          onClick={() => closePage()}
          title="关闭"
          className="inline-flex items-center rounded-md px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {conflictMerged !== null && (
        <div className="border-b border-amber-200 bg-amber-50 text-amber-900 px-4 py-2 text-xs flex items-center gap-2">
          <span>他人更新导致冲突。点“载入合并结果”会把双方文本插入编辑器，手工删除冲突标记后再保存。</span>
          <button className="ml-auto rounded bg-amber-600 text-white px-2 py-1 text-xs" onClick={applyConflictAndSave}>载入合并结果</button>
        </div>
      )}
      <div ref={ref} className="flex-1 overflow-auto bg-white" />
    </div>
  );
}
