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
  const [loaded, setLoaded] = useState<{ title: string; body: string; last_author?: string; last_commit_at?: string; last_commit_sha?: string } | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const titleDirtyRef = useRef(false);

  // Load page content & connect presence.
  useEffect(() => {
    if (!currentRepo || !pageId) return;
    let cancelled = false;
    titleDirtyRef.current = false;
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

  // Init CodeMirror once content is loaded.
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
          placeholder("开始写正文…"),
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
  }, [loaded]);

  async function doSave() {
    if (!currentRepo || !pageId || !viewRef.current) return;
    const body = viewRef.current.state.doc.toString();
    setSaveStatus("saving");
    try {
      const sha = conflictSha ?? baseSha;
      const res = await api.savePage(currentRepo, {
        id: pageId,
        title: titleInput.trim() || "未命名",
        body,
        base_sha: sha,
      });
      if ("conflict" in res && res.conflict) {
        // Server merged the whole page text (front matter + body). For the UI we show
        // the merged result as the new editor body — but the front matter block is not
        // what the user edits, so we extract the merged body via a lightweight parse.
        setConflictMerged(res.merged);
        setConflictSha(res.current_sha);
        setSaveStatus("conflict");
        return;
      }
      if ("commit_sha" in res) {
        bumpBaseSha(res.commit_sha);
        markDirty(false);
        titleDirtyRef.current = false;
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
    // Strip the front matter block from merged content: UI only owns body.
    const m = conflictMerged.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    const mergedBody = m ? m[1] : conflictMerged;
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: mergedBody },
    });
    if (conflictSha) bumpBaseSha(conflictSha);
    setConflictMerged(null);
    toast.info("冲突内容已并入正文编辑器（front matter 服务端已合并），请手工解决 <<< 标记后再保存");
  }

  if (!currentRepo || !pageId) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-neutral-200 bg-white px-4 py-2 flex items-center gap-2 text-sm">
        <div className="text-neutral-400 font-mono text-xs">{pageId}</div>
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
          <span>他人更新导致冲突。点“载入合并结果”查看合并文本，手工删除冲突标记后再保存。</span>
          <button className="ml-auto rounded bg-amber-600 text-white px-2 py-1 text-xs" onClick={applyConflictAndSave}>载入合并结果</button>
        </div>
      )}
      <div className="bg-white border-b border-neutral-100 px-6 pt-6 pb-3">
        <input
          value={titleInput}
          onChange={(e) => {
            setTitleInput(e.target.value);
            titleDirtyRef.current = true;
            markDirty(true);
          }}
          placeholder="未命名页面"
          className="w-full text-3xl font-semibold tracking-tight outline-none placeholder:text-neutral-300"
        />
      </div>
      <div ref={ref} className="flex-1 overflow-auto bg-white px-6" />
      {loaded?.last_author && (
        <div className="border-t border-neutral-100 bg-white px-6 py-1.5 text-xs text-neutral-400 flex items-center gap-3">
          <span>最后由 <span className="font-medium text-neutral-600">{loaded.last_author}</span> 提交</span>
          <span>·</span>
          <span>{formatRelativeTime(loaded.last_commit_at)}</span>
          {loaded.last_commit_sha && (
            <>
              <span>·</span>
              <code className="font-mono text-neutral-400">{loaded.last_commit_sha.slice(0, 7)}</code>
            </>
          )}
        </div>
      )}
    </div>
  );
}
