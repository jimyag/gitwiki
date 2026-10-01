import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCanWrite, useRepoInfo, useStore } from "../store";
import { api, isNotFound, type ConflictResult, type Meta, type PageContent, type PageRef, type Revision, type RevisionContent } from "../lib/api";
import { pagePath } from "../lib/tree";
import { HOME, pathFor } from "../lib/route";
import { clearDraft, loadDraft, saveDraft, type Draft } from "../lib/draft";
import { formatRelativeTime } from "../lib/format";
import { connectPresence, disconnectPresence } from "../lib/ws";
import { toast } from "sonner";
import { ExternalLink, Eye, History, Link2, Paperclip, Pencil, Save, Tag } from "lucide-react";
import { DiffView } from "./editor/DiffView";
import { AssetsPanel } from "./AssetsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { PropertiesBar } from "./PropertiesBar";
import { RecentChanges } from "./RecentChanges";
import { Preview, type Heading } from "./Preview";
import { Toc } from "./Toc";
import { btnGhost, btnOutline, btnPrimary, iconBtn } from "./ui";

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

const titleClass = "w-full text-[30px] sm:text-[32px] font-semibold tracking-tight leading-tight text-stone-900";

// md-editor-rt + CodeMirror is several hundred KB: only fetched when someone starts editing.
const MarkdownEditor = lazy(() => import("./editor/MarkdownEditor"));

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
  const repoInfo = useRepoInfo();
  // Known from the tree before the page itself loads, so the title shows immediately.
  const treeTitle = useStore(s => pagePath(s.tree, s.currentPageId).at(-1)?.title);
  const isHome = pageId === HOME;
  const fallbackTitle = isHome ? repoInfo?.title ?? "首页" : "未命名页面";

  const [mode, setMode] = useState<Mode>("view");
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
  const [panel, setPanel] = useState<"assets" | "history" | null>(null);
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
    (async () => {
      try {
        const pc = await api.readPage(currentRepo, pageId);
        if (cancelled) return;
        applyLoaded(pc);
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
    setMode("edit");
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
      setMode("view");
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
          <h3 className="text-base font-medium text-stone-900 mb-1">
            {loadError === "notfound" ? "页面不存在" : "页面加载失败"}
          </h3>
          <p className="text-sm text-stone-500 break-all">
            {loadError === "notfound" ? "它可能已被删除或移动。删除的页面可以在首页的“最近更新”里恢复。" : loadError}
          </p>
          {loadError === "notfound" && (
            <button onClick={() => useStore.getState().openPage(HOME)} className={`${btnOutline} mt-5`}>回到首页</button>
          )}
        </div>
      </div>
    );
  }
  const editing = mode === "edit";
  const siteUrl = repoInfo?.site_url && !loaded?.meta.draft && !missingHome
    ? repoInfo.site_url.replace(/\/+$/, "") + (isHome ? "/" : `/${pageId}/`)
    : null;

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden bg-white">
      {actionsSlot && createPortal(
        <>
          {conflict ? null : editing ? (
            <>
              <button onClick={() => setMode("view")} title="预览，未保存的修改会保留" className={btnGhost}>
                <Eye className="size-4" /><span className="hidden sm:inline">预览</span>
              </button>
              <button onClick={() => void doSave()} disabled={saveStatus === "saving"} title="保存 (⌘S)" className={btnPrimary}>
                <Save className="size-4" />保存
              </button>
            </>
          ) : canWrite && (
            <button onClick={() => setMode("edit")} disabled={loaded === null} className={btnOutline}>
              <Pencil className="size-3.5" />编辑
            </button>
          )}
          {siteUrl && (
            <a href={siteUrl} target="_blank" rel="noopener noreferrer" title="在站点中查看" className={iconBtn}>
              <ExternalLink className="size-4" />
            </a>
          )}
          <button onClick={() => setPanel("history")} disabled={missingHome} title="页面历史" className={iconBtn}>
            <History className="size-4" />
          </button>
          <button onClick={() => setPanel("assets")} title="附件" className={iconBtn}>
            <Paperclip className="size-4" />
          </button>
        </>,
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
        // Editing gets the whole content area: the title, the page's properties, then the editor
        // filling the rest of the height (it scrolls inside, so its toolbar stays put). Stays
        // mounted (hidden) under the conflict view so the editor keeps its undo history.
        <div className={conflict ? "hidden" : "flex-1 min-h-0 flex flex-col gap-2 sm:gap-2.5 px-2 sm:px-6 pt-3 sm:pt-4 pb-2 sm:pb-4"}>
          <input
            value={titleInput}
            onChange={(e) => {
              setTitleInput(e.target.value);
              markDirty(true);
            }}
            placeholder={fallbackTitle}
            className="w-full max-w-[1600px] mx-auto px-1 text-[22px] sm:text-2xl font-semibold tracking-tight text-stone-900 bg-transparent outline-none placeholder:text-stone-300"
          />
          <PropertiesBar meta={meta} onChange={(m) => { setMeta(m); markDirty(true); }} />
          <div className="flex-1 min-h-0 w-full max-w-[1600px] mx-auto">
            <Suspense fallback={<div className="gitwiki-md rounded-lg border border-stone-200 bg-stone-50 animate-pulse" />}>
              <MarkdownEditor
                value={draft ?? loaded.body}
                onChange={(v) => { setDraft(v); markDirty(true); }}
                onUpload={uploadAsset}
              />
            </Suspense>
          </div>
        </div>
      ) : (
      <div ref={scrollRef} className={conflict ? "hidden" : "@container flex-1 overflow-auto"}>
        {/* When the content area is wide enough the article stays centered and the TOC takes the right gutter. */}
        <div className="@min-[1140px]:grid @min-[1140px]:grid-cols-[minmax(0,1fr)_720px_minmax(0,1fr)] @min-[1140px]:gap-8">
        <div className="hidden @min-[1140px]:block" />
        <article className="w-full max-w-[720px] mx-auto px-5 sm:px-10 pt-8 sm:pt-12 pb-24">
          <h1 className={titleClass}>{titleInput || treeTitle || fallbackTitle}</h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-stone-400">
            {loaded?.meta.draft && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200" title="草稿不会发布到站点">草稿</span>
            )}
            {loaded?.last_author && (
              <span><span className="text-stone-600">{loaded.last_author}</span> 编辑于 {formatRelativeTime(loaded.last_commit_at)}</span>
            )}
            {loaded?.meta.tags.map(t => (
              <button
                key={t}
                onClick={() => useStore.getState().setTagsOpen(t)}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-stone-100 text-xs text-stone-600 hover:bg-stone-200 hover:text-stone-900 transition"
              >
                <Tag className="size-3" />{t}
              </button>
            ))}
          </div>
          {loaded?.meta.description && (
            <p className="mt-4 text-[17px] leading-relaxed text-stone-500">{loaded.meta.description}</p>
          )}

          {stored && (
            <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="flex-1 min-w-[12rem]">
                本机有 {formatRelativeTime(stored.at)} 未保存的修改{stored.baseSha && stored.baseSha !== baseSha ? "，之后页面又被更新过，保存时会自动合并" : ""}
              </span>
              <button onClick={discardDraft} className="h-7 px-2.5 rounded-md text-amber-800 hover:bg-amber-100 transition">丢弃</button>
              <button onClick={restoreDraft} className="h-7 px-2.5 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700 transition">恢复并继续编辑</button>
            </div>
          )}

          <div className="mt-8">
            {loaded === null ? (
              <div className="space-y-3 animate-pulse" aria-label="加载中">
                <div className="h-4 rounded bg-stone-100 w-11/12" />
                <div className="h-4 rounded bg-stone-100 w-4/5" />
                <div className="h-4 rounded bg-stone-100 w-2/3" />
              </div>
            ) : missingHome && !draft ? (
              <div className="rounded-lg border border-dashed border-stone-300 px-5 py-8 text-center text-sm text-stone-500">
                首页还没有内容。{canWrite ? "点右上角的“编辑”开始写。" : ""}
              </div>
            ) : (
              <Preview body={draft ?? loaded.body} onHeadings={setHeadings} />
            )}
          </div>

          {backlinks.length > 0 && (
            <section className="mt-14 pt-5 border-t border-stone-200">
              <h2 className="flex items-center gap-2 mb-2 text-sm font-semibold text-stone-900">
                <Link2 className="size-4 text-stone-400" />链接到本页的页面
              </h2>
              <ul className="flex flex-wrap gap-2">
                {backlinks.map(b => (
                  <li key={b.id}>
                    <a
                      href={pathFor(currentRepo, b.id)}
                      onClick={(e) => { e.preventDefault(); useStore.getState().openPage(b.id); }}
                      className="inline-flex items-center h-7 px-2.5 rounded-md border border-stone-200 text-[13px] text-stone-700 hover:border-stone-300 hover:bg-stone-50 transition"
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
            <div className="sticky top-0 max-h-[calc(100dvh-3rem)] overflow-y-auto pt-14 pb-10 pr-6">
              <Toc headings={headings} scrollRoot={scrollRef} />
            </div>
          )}
        </aside>
        </div>
      </div>
      )}
    </div>
  );
}
