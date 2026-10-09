import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Copy, Download, FileIcon, ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { attachmentName as displayName } from "../lib/format";
import { Dialog, DialogHeader, btnSecondary } from "./ui";

const imageName = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

// The page's attachments (files in its assets/ folder): upload, copy a reference, download, delete.
export function AssetsPanel({ body, canWrite, onUpload, onClose }: {
  body: string; // the page text, to warn before deleting a file it still uses
  canWrite: boolean;
  onUpload(file: File): Promise<string>;
  onClose(): void;
}) {
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const [assets, setAssets] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const reload = () => {
    if (!currentRepo || !pageId) return;
    api.listAssets(currentRepo, pageId).then(setAssets, () => setAssets([]));
  };
  useEffect(reload, [currentRepo, pageId]);

  const upload = async (files: File[]) => {
    await Promise.allSettled(files.map(onUpload)); // failures are reported by onUpload
    reload();
  };

  const remove = async (name: string) => {
    if (!currentRepo || !pageId) return;
    const used = body.includes(`assets/${name}`);
    const shown = displayName(name);
    if (!confirm(used ? `正文里还在用 ${shown}，删除后那里会失效。确定删除？` : `删除附件 ${shown}？`)) return;
    try {
      await api.deleteAsset(currentRepo, pageId, name);
      setAssets(a => a?.filter(x => x !== name) ?? null);
      toast.success("已删除附件");
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    }
  };

  const copyRef = (name: string) => {
    const ref = `${imageName.test(name) ? "!" : ""}[${displayName(name)}](assets/${name})`;
    navigator.clipboard.writeText(ref).then(() => toast.success("已复制引用，粘贴到正文即可"), () => toast.error("复制失败"));
  };

  return (
    <Dialog onClose={onClose} center className="max-w-[640px] max-h-[75vh] flex flex-col">
      <DialogHeader icon={Paperclip} title="附件" meta={assets && `${assets.length} 个`} onClose={onClose}>
        {canWrite && (
          <>
            <button onClick={() => input.current?.click()} className={btnSecondary}>
              <Upload className="size-3.5" />上传
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void upload(files); }}
            />
          </>
        )}
      </DialogHeader>
      <div className="flex-1 overflow-auto p-4">
        {assets === null && <div className="py-8 text-center text-xs text-fg-muted">加载中…</div>}
        {assets?.length === 0 && (
          <div className="py-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-subtle ring-1 ring-line">
              <ImageIcon className="size-5 text-fg-subtle" />
            </div>
            <p className="mt-3 text-sm font-medium text-fg">本页还没有附件</p>
            {canWrite && <p className="mt-1 text-xs text-fg-muted">在编辑器里粘贴图片，或用工具栏的回形针上传任意文件</p>}
          </div>
        )}
        {!!assets?.length && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {assets.map(name => (
              <AssetCard
                key={name}
                url={api.assetUrl(currentRepo!, pageId!, name)}
                name={name}
                onCopy={() => copyRef(name)}
                onDelete={canWrite ? () => void remove(name) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AssetCard({ url, name: stored, onCopy, onDelete }: { url: string; name: string; onCopy(): void; onDelete?: () => void }) {
  const isImage = imageName.test(stored);
  const [showPreview, setShowPreview] = useState(false);
  const name = displayName(stored);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "FILE";
  const action = "p-1 rounded-md text-fg-subtle transition-colors hover:bg-shade";

  return (
    <>
      <div className="group overflow-hidden rounded-xl bg-subtle ring-1 ring-line transition hover:ring-line-strong">
        {isImage ? (
          <button onClick={() => setShowPreview(true)} className="block w-full aspect-square overflow-hidden" title="查看大图">
            <img src={url} alt={name} className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" loading="lazy" />
          </button>
        ) : (
          <a href={url} download={name} className="w-full aspect-square flex flex-col items-center justify-center gap-2 text-fg-subtle transition-colors hover:text-fg-muted" title="下载">
            <FileIcon className="size-8" />
            <span className="text-[11px] font-semibold tracking-wide">{ext}</span>
          </a>
        )}
        <div className="flex items-center gap-0.5 border-t border-line bg-raised p-1.5 pl-2.5">
          <span className="flex-1 truncate text-xs text-fg-2" title={name}>{name}</span>
          <button onClick={onCopy} title="复制引用" className={`${action} hover:text-accent-strong`}>
            <Copy className="size-3.5" />
          </button>
          <a href={url} download={name} title="下载" className={`${action} hover:text-fg`}>
            <Download className="size-3.5" />
          </a>
          {onDelete && (
            <button onClick={onDelete} title="删除" className={`${action} hover:text-red-600`}>
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/85 p-8 backdrop-blur-sm animate-fade-in" onClick={() => setShowPreview(false)}>
          <img src={url} alt={name} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}
