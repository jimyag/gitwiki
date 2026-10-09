import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCanWrite, useRepoInfo, useStore } from "../store";
import { api, isNotFound, type ConflictResult, type Meta, type PageContent, type PageMeta, type PageRef, type Revision, type RevisionContent } from "../lib/api";
import { descendants, pageExists, pagePath } from "../lib/tree";
import { HOME, pathFor, setHash } from "../lib/route";
import { clearDraft, loadDraft, saveDraft, type Draft } from "../lib/draft";
import { formatRelativeTime } from "../lib/format";
import { pushRecent } from "../lib/recents";
import { sendEditing } from "../lib/ws";
import { connectPresence, disconnectPresence } from "../lib/ws";
import { toast } from "sonner";
import { Archive, Eye, FileQuestion, FileText, Folder, FolderTree, Link2, Pencil, Save, Undo2 } from "lucide-react";
import { DiffView } from "./editor/DiffView";
import type { EditorHandle } from "./editor/MarkdownEditor";
import { AssetsPanel } from "./AssetsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PropertiesBar } from "./PropertiesBar";
import { RecentChanges } from "./RecentChanges";
import { CommentsPanel } from "./CommentsPanel";
import { Preview, type Heading } from "./Preview";
import { Toc } from "./Toc";
import { Avatar, btnGhost, btnPrimary, btnSecondary, shortcutBlocked } from "./ui";

interface LoadedPage {
  title: string;
  body: string;
  meta: Meta;
  last_author?: string;
  last_commit_at?: string;
}

type Mode = "view" | "edit";

const emptyMeta: Meta = { tags: [], draft: false, description: "", date: "" };
const sameMeta = (a: Meta, b: Meta) => JSON.stringify(a) === JSON.stringify(b);

// The page title reads the same in both modes, so switching does not make it jump.
const titleClass = "w-full text-[28px] sm:text-[34px] font-semibold tracking-[-0.015em] leading-[1.25] text-fg";
const callout = "flex gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-500/25 dark:text-amber-200";

// md-editor-rt + CodeMirror is several hundred KB: only fetched when someone starts editing.
const MarkdownEditor = lazy(() => import("./editor/MarkdownEditor"));

// readingLine is the source line of the first block showing at the top of the reading view
// (Preview tags blocks with data-line), or of the last block when scrolled past them all.
function readingLine(root: HTMLElement | null): number {
  if (!root) return 0;
  const top = root.getBoundingClientRect().top;
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-line]")];
  const block = blocks.find(b => b.getBoundingClientRect().bottom > top) ?? blocks.at(-1);
  return Number(block?.dataset.line ?? 0);
}

// blockAt is the rendered block holding source line line: the last one starting at or above it.
function blockAt(root: HTMLElement, line: number): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>("[data-line]")].filter(b => Number(b.dataset.line) <= line).at(-1);
}

// Whether the editor shows the preview beside it: a preference of this browser.
const SPLIT_KEY = "gitwiki.editSplit";
function savedSplit(): boolean {
  try { return localStorage.getItem(SPLIT_KEY) === "1"; } catch { return false; }
}

export function Editor() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const baseSha = useStore(s => s.baseSha);
  const dirty = useStore(s => s.dirty);
  const setSaveStatus = useStore(s => s.setSaveStatus);
  const markDirty = useStore(s => s.markDirty);
  const bumpBaseSha = useStore(s => s.bumpBaseSha);
  const saveStatus = useStore(s => s.saveStatus);
  const canWrite = useCanWrite();
  const tree = useStore(s => s.tree);
  const requestedLine = useStore(s => s.requestedLine);
  const repoInfo = useRepoInfo();
  // Known from the tree before the page itself loads, so the title shows immediately.
  const treeTitle = useStore(s => pagePath(s.tree, s.currentPageId).at(-1)?.title);
  const isHome = pageId === HOME;
  const wikiTitle = useStore(s => s.settings?.title) ?? repoInfo?.title;
  const fallbackTitle = isHome ? wikiTitle ?? "首页" : "未命名页面";

  const [mode, setMode] = useState<Mode>("view");
  const wide = useStore(s => s.pageWide);
  const setWide = useStore(s => s.setPageWide);
  const [split, setSplitState] = useState(savedSplit);
  const setSplit = (on: boolean) => {
    try {
      if (on) localStorage.setItem(SPLIT_KEY, "1");
      else localStorage.removeItem(SPLIT_KEY);
    } catch {}
    setSplitState(on);
  };
  const [full, setFull] = useState(false); // the editor covers the window
  const splitRef = useRef<HTMLDivElement>(null);
  // Known from the tree: the pages under this one, listed at the end of the reading view.
  const childPages = useStore(s => (s.currentPageId === HOME ? undefined : pagePath(s.tree, s.currentPageId).at(-1)?.children));
  const searchTerms = useStore(s => s.searchHighlight);
  // The source line at the top of the screen when switching between reading and editing, so
  // the other view opens at the same block.
  const [line, setLine] = useState(0);
  const editorRef = useRef<EditorHandle>(null);
  const [conflict, setConflict] = useState<ConflictResult | null>(null);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null); // "notfound" or a message
  const [missingHome, setMissingHome] = useState(false); // no content/_index.md yet
  // The body being edited (null until the first change). It outlives the editor, so switching
  // to preview and back keeps unsaved text, and a conflict merge simply replaces it.
  const [draft, setDraft] = useState<string | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [meta, setMeta] = useState<Meta>(emptyMeta);
  const [stored, setStored] = useState<Draft | null>(null); // an earlier session's unsaved edits
  const panel = useStore(s => s.panel);
  const setPanel = useStore(s => s.setPanel);
  const user = useStore(s => s.user);
  const [backlinks, setBacklinks] = useState<PageRef[]>([]);
  // The TopBar renders an empty #page-actions slot; this page's buttons are portaled into it.
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setActionsSlot(document.getElementById("page-actions")), []);

  // Tab title and history entries show the page, now that each page has its own URL.
  useEffect(() => {
    document.title = `${titleInput || treeTitle || fallbackTitle} · gitwiki`;
    return () => { document.title = "gitwiki"; };
  }, [titleInput, treeTitle, fallbackTitle]);

  useEffect(() => {
    if (!currentRepo || !pageId) return;
    let cancelled = false;
    setMode("view"); // opening a page → default to preview
    setLine(0);
    (async () => {
      try {
        const pc = await api.readPage(currentRepo, pageId);
        if (cancelled) return;
        applyLoaded(pc);
        pushRecent(currentRepo, pageId, pc.title || pageId);
        offerDraft(pc);
      } catch (e: any) {
        if (cancelled) return;
        const notFound = isNotFound(e);
        if (!(notFound && pageId === HOME)) {
          // Pages have URLs now, so stale links happen; show it instead of an endless skeleton.
          setLoadError(notFound ? "notfound" : e.message);
          return;
        }
        // No home page yet: show an empty one; the first save creates content/_index.md.
        const empty: PageContent = { id: HOME, title: "", body: "", meta: emptyMeta, base_sha: "", is_bundle: false };
        setMissingHome(true);
        applyLoaded(empty);
        offerDraft(empty);
      }
      connectPresence(currentRepo, pageId);
    })();
    if (pageId !== HOME) api.backlinks(currentRepo, pageId).then(b => !cancelled && setBacklinks(b), () => {});
    return () => {
      cancelled = true;
      disconnectPresence();
    };
  }, [currentRepo, pageId]);

  const peers = useStore(s => s.peers);
  const othersEditing = peers.filter(p => p.editing && p.user !== useStore.getState().user?.login);

  // Tell the others when this tab's editor opens/closes, so their edit button can warn.
  useEffect(() => {
    sendEditing(mode === "edit");
    return () => sendEditing(false);
  }, [mode, currentRepo, pageId]);

  // Switching views keeps the place: the editor opens at the block at the top of the reading
  // view, and the reading view comes back at the block at the top of the editor.
  function startEditing() {
    setLine(readingLine(scrollRef.current));
    setMode("edit");
    useStore.getState().setSearchHighlight([]);
  }

  function stopEditing() {
    setLine(editorRef.current?.topLine() ?? 0);
    setMode("view");
    setFull(false);
  }

  // The 编辑 button and the E key: someone else having the editor open is worth a question.
  function edit() {
    if (othersEditing.length > 0 &&
        !confirm(othersEditing.map(p => p.name || p.user).join("、") + " 正在编辑这一页。现在打开编辑器，你们的修改保存时会自动合并，改到同一处时需要人工挑。继续？")) return;
    startEditing();
  }

  useEffect(() => {
    if (mode !== "view" || !canWrite || loaded === null || conflict) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "e" && e.key !== "E") || shortcutBlocked(e)) return;
      e.preventDefault();
      edit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (mode !== "view" || !line || !root) return;
    const block = blockAt(root, line);
    if (!block) return;
    setHash(null); // the table of contents would jump back to the section read before editing
    block.scrollIntoView({ block: "start" });
  }, [mode]);

  useEffect(() => {
    if (!loaded || !requestedLine) return;
    setLine(requestedLine);
    setMode(canWrite ? "edit" : "view");
    if (!canWrite && scrollRef.current) blockAt(scrollRef.current, requestedLine)?.scrollIntoView({ block: "center" });
    useStore.getState().requestLine(0);
  }, [loaded, requestedLine, canWrite]);

  // Opened from a search result: the matched terms are marked, and the first one in the body is
  // scrolled into view. CSS highlights leave React's DOM alone; they are redrawn when the page
  // re-renders (code highlighting, diagrams). Esc, editing or another page clears them.
  useEffect(() => {
    const root = scrollRef.current;
    if (mode !== "view" || !searchTerms.length || !root || !loaded || !("highlights" in CSS)) return;
    const re = new RegExp(searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
    let frame = 0;
    let scrolled = false;
    const mark = () => {
      frame = 0;
      const ranges: Range[] = [];
      for (const scope of root.querySelectorAll("[data-search-scope], .prose-preview")) {
        const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          for (const m of (n.nodeValue ?? "").matchAll(re)) {
            const r = document.createRange();
            r.setStart(n, m.index ?? 0);
            r.setEnd(n, (m.index ?? 0) + m[0].length);
            ranges.push(r);
          }
        }
      }
      CSS.highlights.set("search-hit", new Highlight(...ranges));
      const first = ranges.find(r => r.startContainer.parentElement?.closest(".prose-preview"));
      if (first && !scrolled) {
        scrolled = true;
        root.scrollTop += first.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 3;
      }
    };
    mark();
    const observer = new MutationObserver(() => { frame ||= requestAnimationFrame(mark); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !shortcutBlocked(e)) useStore.getState().setSearchHighlight([]);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      CSS.highlights.delete("search-hit");
    };
  }, [mode, searchTerms, loaded]);

  // The split preview follows the editor: the block at the top of the source shows at its top.
  const followEditor = useCallback((at: number) => {
    const pane = splitRef.current;
    if (!pane) return;
    const block = blockAt(pane, at);
    pane.scrollTop = block ? pane.scrollTop + block.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24 : 0;
  }, []);
  useEffect(() => {
    if (split && mode === "edit") requestAnimationFrame(() => followEditor(editorRef.current?.topLine() ?? 0));
  }, [split, mode, followEditor]);
  const previewBody = useDeferredValue(draft ?? loaded?.body ?? "");

  function applyLoaded(pc: PageContent) {
    setLoaded({
      title: pc.title,
      body: pc.body,
      meta: pc.meta,
      last_author: pc.last_author,
      last_commit_at: pc.last_commit_at,
    });
    setDraft(null);
    setTitleInput(pc.title);
    setMeta(pc.meta);
    bumpBaseSha(pc.base_sha);
    markDirty(false);
  }

  // Unsaved edits are mirrored to a local draft; one that differs from the page is offered back.
  function offerDraft(pc: PageContent) {
    if (!currentRepo || !pageId || !canWrite) return;
    const d = loadDraft(currentRepo, pageId);
    if (!d) return;
    if (d.title === pc.title && d.body === pc.body && sameMeta(d.meta, pc.meta)) clearDraft(currentRepo, pageId);
    else setStored(d);
  }

  const latest = useRef<Draft | null>(null);
  latest.current = dirty && loaded ? { title: titleInput, body: draft ?? loaded.body, meta, baseSha, at: Date.now() } : null;
  useEffect(() => {
    const moved = (event: Event) => {
      const d = (event as CustomEvent<{ repo: string; from: string; to: string; ok: boolean }>).detail;
      if (!latest.current || d.repo !== currentRepo || !pageId || !(pageId === d.from || pageId.startsWith(d.from + "/"))) return;
      d.ok = saveDraft(d.repo, d.to + pageId.slice(d.from.length), latest.current);
      if (d.ok) latest.current = null; // cleanup must not recreate a draft at the old address
    };
    window.addEventListener("gitwiki:page-moved", moved);
    return () => window.removeEventListener("gitwiki:page-moved", moved);
  }, [currentRepo, pageId]);
  useEffect(() => {
    if (!dirty || !currentRepo || !pageId) return;
    const t = setTimeout(() => latest.current && saveDraft(currentRepo, pageId, latest.current), 500);
    return () => clearTimeout(t);
  }, [dirty, draft, titleInput, meta, currentRepo, pageId]);
  // Leaving within that half second must not drop the last keystrokes.
  useEffect(() => () => {
    if (latest.current && currentRepo && pageId) saveDraft(currentRepo, pageId, latest.current);
  }, [currentRepo, pageId]);

  function restoreDraft() {
    if (!stored) return;
    setDraft(stored.body);
    setTitleInput(stored.title);
    setMeta(stored.meta ?? emptyMeta);
    // Saving merges from the version the draft started from, so newer edits are kept.
    if (stored.baseSha) bumpBaseSha(stored.baseSha);
    markDirty(true);
    setStored(null);
    startEditing();
  }

  function discardDraft() {
    if (currentRepo && pageId) clearDraft(currentRepo, pageId);
    setStored(null);
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

  // Upload for the editor (paste, drop, toolbar) and the attachments panel: progress goes to
  // the UploadBar and the returned path ("assets/x.png") is what gets linked.
  async function uploadAsset(file: File): Promise<string> {
    if (!currentRepo || !pageId) throw new Error("no page open");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    useStore.getState().addUpload({ id, filename: file.name, pct: 0, status: "uploading" });
    try {
      const res = await api.uploadAsset(currentRepo, pageId, file, (pct) => {
        useStore.getState().updateUpload(id, { pct });
      });
      useStore.getState().updateUpload(id, { pct: 100, status: "done" });
      setTimeout(() => useStore.getState().removeUpload(id), 2500);
      return res.path;
    } catch (e: any) {
      useStore.getState().updateUpload(id, { status: "error", error: e.message });
      toast.error(`上传失败：${e.message}`);
      throw e;
    }
  }

  // doSave saves the editor's content, or other content (restoring an old version). It
  // reports whether the save went through.
  async function doSave(other?: { title: string; body: string; meta: Meta; message: string }): Promise<boolean> {
    if (!currentRepo || !pageId || loaded === null || !canWrite) return false;
    // While the conflict view is open the user must pick the merge or go back first;
    // saving the editor text on top of the newer HEAD would drop the other edit.
    if (conflict) return false;
    if (useStore.getState().saveStatus === "saving") return false; // repeated Cmd+S while in flight
    setSaveStatus("saving");
    try {
      const res = await api.savePage(currentRepo, {
        id: pageId,
        title: (other?.title ?? titleInput).trim() || fallbackTitle,
        body: other?.body ?? draft ?? loaded.body,
        meta: other?.meta ?? meta,
        base_sha: baseSha,
        message: other?.message,
      });
      if ("conflict" in res) {
        setConflict(res);
        setSaveStatus("conflict");
        return false;
      }
      bumpBaseSha(res.commit_sha);
      markDirty(false);
      clearDraft(currentRepo, pageId);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
      setMissingHome(false);
      applyLoaded(await api.readPage(currentRepo, pageId));
      stopEditing();
      return true;
    } catch (e: any) {
      setSaveStatus("error");
      toast.error(isNotFound(e)
        ? "页面已被删除或移动，没有保存。修改留在本机草稿里"
        : `保存失败：${e.message}`);
      return false;
    }
  }

  async function restoreRevision(rev: Revision, c: RevisionContent) {
    if (useStore.getState().dirty && !confirm("当前有未保存的修改，恢复旧版本会替换它们。继续？")) return;
    const ok = await doSave({ title: c.title, body: c.body, meta: c.meta, message: `wiki: restore ${pageId} to ${rev.sha.slice(0, 7)}` });
    if (ok) {
      setPanel(null);
      toast.success("已恢复到这个版本");
    }
  }

  if (!currentRepo || !pageId) return null;
  if (loadError) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-subtle ring-1 ring-line">
            <FileQuestion className="size-5 text-fg-subtle" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-fg">
            {loadError === "notfound" ? "页面不存在" : "页面加载失败"}
          </h3>
          <p className="mt-1 text-sm text-fg-muted break-all">
            {loadError === "notfound" ? "它可能已被删除或移动。删除的页面可以在首页的“最近更新”里恢复。" : loadError}
          </p>
          {loadError === "notfound" && (
            <button onClick={() => useStore.getState().openPage(HOME)} className={`${btnSecondary} mt-5`}>回到首页</button>
          )}
        </div>
      </div>
    );
  }
  const editing = mode === "edit";
  const updated = loaded?.last_commit_at;

  return (
    // The comments panel docks on the right and the page gives it room, instead of lying on top.
    <div className="flex-1 min-h-0 flex print:block">
      <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden print:block print:overflow-visible">
      {actionsSlot && !conflict && createPortal(
        editing ? (
          <>
            <button onClick={stopEditing} title="预览，未保存的修改会保留" className={btnGhost}>
              <Eye className="size-4" /><span className="hidden sm:inline">预览</span>
            </button>
            <button onClick={() => void doSave()} disabled={saveStatus === "saving"} title="保存 (⌘S)" className={btnPrimary}>
              <Save className="size-4" />保存
            </button>
          </>
        ) : canWrite && (
          <button onClick={edit} disabled={loaded === null} title="编辑 (E)" className={btnSecondary}>
            <Pencil className="size-3.5" />编辑
          </button>
        ),
        actionsSlot,
      )}

      {panel === "assets" && (
        <AssetsPanel body={draft ?? loaded?.body ?? ""} canWrite={canWrite} onUpload={uploadAsset} onClose={() => setPanel(null)} />
      )}
      {panel === "history" && loaded && (
        <HistoryPanel
          pageId={pageId}
          current={{ title: titleInput, body: draft ?? loaded.body }}
          canRestore={canWrite}
          onRestore={restoreRevision}
          onClose={() => setPanel(null)}
        />
      )}

      {conflict && (
        <DiffView
          theirsBody={conflict.theirs_body}
          oursBody={conflict.ours_body}
          mergedWholeText={conflict.merged}
          onApplyMergedBody={(body) => {
            setDraft(body);
            if (conflict.current_sha) bumpBaseSha(conflict.current_sha);
            setConflict(null);
            setSaveStatus("idle");
            setMode("edit");
            toast.info("已载入合并结果，请检查后再次保存");
          }}
          onDismiss={() => { setConflict(null); setSaveStatus("idle"); }}
        />
      )}

      {editing && loaded ? (
        // Editing gets the content area's whole height, in a column about as wide as the reading
        // view (the whole width with the preview beside it): the title, the page's properties,
        // then the editor filling the rest of the height (it scrolls inside, so its toolbar stays
        // put). Stays mounted (hidden) under the conflict view so the editor keeps its undo
        // history.
        <div className={conflict ? "hidden" : "flex-1 min-h-0 flex flex-col px-2 sm:px-6 pt-4 sm:pt-8 pb-2 sm:pb-3"}>
          <div className={"w-full mx-auto flex-1 min-h-0 flex flex-col gap-3 " + (wide || split ? "max-w-none" : "max-w-3xl")}>
            <input
              value={titleInput}
              onChange={(e) => {
                setTitleInput(e.target.value);
                markDirty(true);
              }}
              placeholder={fallbackTitle}
              aria-label="页面标题"
              className={`${titleClass} px-1 bg-transparent outline-none placeholder:text-fg-subtle`}
            />
            <PropertiesBar meta={meta} onChange={(m) => { setMeta(m); markDirty(true); }} />
            <div className={full ? "fixed inset-0 z-30 flex gap-4 bg-surface p-2" : "flex-1 min-h-0 mt-1 flex gap-4"}>
              <div className="flex-1 min-w-0">
                <Suspense fallback={<div className="h-full rounded-xl bg-subtle animate-pulse" />}>
                  <MarkdownEditor
                    ref={editorRef}
                    line={line}
                    value={draft ?? loaded.body}
                    onChange={(v) => { setDraft(v); markDirty(true); }}
                    onUpload={uploadAsset}
                    wide={wide}
                    onWideChange={setWide}
                    split={split}
                    onSplitChange={setSplit}
                    full={full}
                    onFullChange={setFull}
                    onScrollLine={split ? followEditor : undefined}
                  />
                </Suspense>
              </div>
              {split && (
                <div ref={splitRef} aria-label="预览" className="hidden xl:block flex-1 min-w-0 overflow-auto rounded-xl px-8 py-6 ring-1 ring-line">
                  <Preview body={previewBody} />
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
      <div ref={scrollRef} className={conflict ? "hidden" : "@container flex-1 overflow-auto print:overflow-visible"}>
        {/* When the content area is wide enough the TOC takes a right column: beside an article
            kept centered at page width, or beside one that fills the rest in wide mode. */}
        <div className={wide
          ? "@min-[1140px]:grid @min-[1140px]:grid-cols-[minmax(0,1fr)_15rem] @min-[1140px]:gap-6"
          : "@min-[1140px]:grid @min-[1140px]:grid-cols-[minmax(0,1fr)_720px_minmax(0,1fr)] @min-[1140px]:gap-10"}>
        {!wide && <div className="hidden @min-[1140px]:block" />}
        <article className={"w-full mx-auto px-5 sm:px-10 pt-10 sm:pt-16 pb-28" + (wide ? "" : " max-w-[720px]")}>
          <h1 data-search-scope className={titleClass}>{titleInput || treeTitle || fallbackTitle}</h1>

          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-fg-muted">
            {loaded?.meta.draft && (
              <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300" title="草稿不会发布到站点">草稿</span>
            )}
            {(loaded?.last_author || updated) && (
              <span className="inline-flex items-center gap-1.5">
                {loaded?.last_author && <>
                  <Avatar login={loaded.last_author} className="size-5 text-[9px]" />
                  <span className="font-medium text-fg-2">{loaded.last_author}</span>
                </>}
                {loaded?.last_author && updated && <span className="text-fg-subtle">·</span>}
                {updated && (
                  <time dateTime={updated} title={new Date(updated).toLocaleString()}>
                    更新于 {formatRelativeTime(updated)}
                  </time>
                )}
              </span>
            )}
            {loaded?.meta.owner && (
              <span className="inline-flex items-center gap-1.5" title="负责维护这一页的人">
                <span className="text-fg-subtle">负责人</span>
                <Avatar login={loaded.meta.owner} className="size-5 text-[9px]" />
                <span className="font-medium text-fg-2">{loaded.meta.owner}</span>
              </span>
            )}
            {!!loaded?.meta.tags.length && (
              <span className="flex flex-wrap gap-1.5">
                {loaded.meta.tags.map(t => (
                  <button
                    key={t}
                    onClick={() => useStore.getState().setTagsOpen(t)}
                    className="h-6 px-2 rounded-full bg-shade text-xs text-fg-muted transition-colors hover:bg-accent-soft hover:text-accent-strong"
                  >
                    #{t}
                  </button>
                ))}
              </span>
            )}
          </div>
          {meta.deprecated && (
            <div role="note" className={`${callout} mt-6`}>
              <Archive className="size-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">此文档已废弃，请勿继续按其中的说明操作。</p>
                {meta.replaced_by && (tree && pageExists(tree, meta.replaced_by) ? (
                  <a href={pathFor(currentRepo, meta.replaced_by)} onClick={e => { e.preventDefault(); useStore.getState().openPage(meta.replaced_by!); }} className="mt-1 inline-block underline underline-offset-2">
                    查看替代页面：{meta.replaced_by === HOME ? "首页" : pagePath(tree, meta.replaced_by).at(-1)?.title}
                  </a>
                ) : <p className="mt-1">替代页面已不存在，请联系文档维护者。</p>)}
              </div>
            </div>
          )}

          {loaded?.meta.description && (
            <p className="mt-5 text-[17px] leading-relaxed text-fg-muted">{loaded.meta.description}</p>
          )}

          {stored && (
            <div className={`${callout} mt-6 flex-wrap items-center`}>
              <Undo2 className="size-4 shrink-0" />
              <span className="flex-1 min-w-[12rem]">
                本机有 {formatRelativeTime(stored.at)} 未保存的修改{stored.baseSha && stored.baseSha !== baseSha ? "，之后页面又被更新过，保存时会自动合并" : ""}
              </span>
              <span className="flex gap-1.5">
                <button onClick={discardDraft} className="h-7 px-2.5 rounded-lg transition-colors hover:bg-amber-500/15">丢弃</button>
                <button onClick={restoreDraft} className="h-7 px-2.5 rounded-lg bg-amber-600 text-white font-medium transition-colors hover:bg-amber-700">恢复并继续编辑</button>
              </span>
            </div>
          )}

          <div className="mt-9">
            {loaded === null ? (
              <div className="space-y-3.5 animate-pulse" aria-label="加载中">
                <div className="h-4 rounded-md bg-shade w-11/12" />
                <div className="h-4 rounded-md bg-shade w-4/5" />
                <div className="h-4 rounded-md bg-shade w-2/3" />
              </div>
            ) : missingHome && !draft ? (
              <div className="rounded-xl border border-dashed border-line-strong px-5 py-10 text-center text-sm text-fg-muted">
                首页还没有内容。{canWrite ? "点右上角的“编辑”开始写。" : ""}
              </div>
            ) : (
              <Preview body={draft ?? loaded.body} onHeadings={setHeadings} />
            )}
          </div>

          {!!childPages?.length && <ChildPages pages={childPages} />}

          {backlinks.length > 0 && (
            <section className="mt-16 pt-6 border-t border-line">
              <h2 className="flex items-center gap-2 mb-3 text-sm font-semibold text-fg">
                <Link2 className="size-4 text-fg-subtle" />链接到本页的页面
                <span className="text-xs font-normal text-fg-subtle">{backlinks.length}</span>
              </h2>
              <ul className="flex flex-wrap gap-2">
                {backlinks.map(b => (
                  <li key={b.id}>
                    <a
                      href={pathFor(currentRepo, b.id)}
                      onClick={(e) => { e.preventDefault(); useStore.getState().openPage(b.id); }}
                      className="inline-flex items-center h-8 px-3 rounded-lg bg-surface text-[13px] text-fg-2 ring-1 ring-line transition-colors hover:bg-subtle hover:text-fg"
                    >{b.title}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {isHome && <RecentChanges />}
        </article>
        <aside className="hidden @min-[1140px]:block">
          {headings.length > 1 && (
            <div className="sticky top-0 max-h-[calc(100dvh-4rem)] overflow-y-auto pt-16 pb-10 pr-6">
              <Toc headings={headings} scrollRoot={scrollRef} />
            </div>
          )}
        </aside>
        </div>
      </div>
      )}
      </div>
      {panel === "comments" && currentRepo && pageId && user && (
        <CommentsPanel repo={currentRepo} pageId={pageId} body={draft ?? loaded?.body ?? ""} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}

const badge = "shrink-0 rounded-md bg-amber-500/10 px-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-300";

// The pages directly under this one, in the sidebar's order: a section page doubles as their
// table of contents, as Hugo's list pages do, with nothing to keep up to date by hand.
function ChildPages({ pages }: { pages: PageMeta[] }) {
  const repo = useStore(s => s.currentRepo);
  if (!repo) return null;
  return (
    <section className="mt-14 print:hidden">
      <h2 className="flex items-center gap-2 mb-3 text-sm font-semibold text-fg">
        <FolderTree className="size-4 text-fg-subtle" />子页面
        <span className="text-xs font-normal text-fg-subtle">{pages.length}</span>
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {pages.map(p => {
          const below = descendants(p);
          const card = "group flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line";
          const body = <>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-shade text-fg-subtle transition-colors group-hover:text-fg-muted">
              {p.has_body ? <FileText className="size-4" /> : <Folder className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-fg">{p.title}</span>
                {p.draft && <span className={badge}>草稿</span>}
                {p.deprecated && <span className={badge}>已废弃</span>}
              </span>
              {below > 0 && <span className="block text-xs text-fg-muted">含 {below} 页</span>}
            </span>
          </>;
          return (
            <li key={p.id}>
              {/* A folder without a page file has nothing to open; its pages are in the sidebar. */}
              {p.has_body ? (
                <a
                  href={pathFor(repo, p.id)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    useStore.getState().openPage(p.id);
                  }}
                  className={`${card} transition hover:bg-subtle hover:ring-line-strong`}
                >{body}</a>
              ) : <div className={card}>{body}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
