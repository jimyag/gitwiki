import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Copy, Download, FileIcon, ImageIcon, Paperclip, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { attachmentName as displayName } from "../lib/format";
import { Dialog, btnOutline } from "./ui";

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
    <Dialog onClose={onClose} center className="max-w-[600px] max-h-[75vh] flex flex-col">
      <div className="h-12 shrink-0 px-4 border-b border-stone-200 flex items-center gap-2">
        <Paperclip className="size-4 text-stone-400" />
        <div className="text-sm font-medium text-stone-900">附件</div>
        {assets && <div className="text-xs text-stone-400">{assets.length} 个</div>}
        {canWrite && (
          <>
            <button onClick={() => input.current?.click()} className={`${btnOutline} ml-auto`}>
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
        <button onClick={onClose} title="关闭" className={`${canWrite ? "" : "ml-auto "}p-1 rounded text-stone-400 hover:text-stone-600 hover:bg-stone-100`}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {assets === null && <div className="py-8 text-center text-xs text-stone-400">加载中…</div>}
        {assets?.length === 0 && (
          <div className="py-12 text-center text-xs text-stone-400 space-y-2">
            <ImageIcon className="size-8 mx-auto text-stone-300" />
            <div>本页还没有附件</div>
            {canWrite && <div>在编辑器里粘贴图片，或用工具栏的回形针上传任意文件</div>}
          </div>
        )}
        {!!assets?.length && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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
  const iconBtn = "p-1 rounded text-stone-400 transition";

  return (
    <>
      <div className="group relative rounded-md border border-stone-200 overflow-hidden bg-stone-50 hover:border-stone-300 transition">
        {isImage ? (
          <button onClick={() => setShowPreview(true)} className="block w-full aspect-square overflow-hidden" title="查看大图">
            <img src={url} alt={name} className="w-full h-full object-cover" loading="lazy" />
          </button>
        ) : (
          <a href={url} download={name} className="w-full aspect-square flex flex-col items-center justify-center gap-2 text-stone-400 hover:text-stone-600" title="下载">
            <FileIcon className="size-8" />
            <span className="text-[11px] font-semibold tracking-wide">{ext}</span>
          </a>
        )}
        <div className="p-1.5 pl-2 bg-white border-t border-stone-100 flex items-center gap-0.5">
          <span className="text-[11px] text-stone-600 truncate flex-1" title={name}>{name}</span>
          <button onClick={onCopy} title="复制引用" className={`${iconBtn} hover:text-emerald-600 hover:bg-emerald-50`}>
            <Copy className="size-3" />
          </button>
          <a href={url} download={name} title="下载" className={`${iconBtn} hover:text-stone-700 hover:bg-stone-100`}>
            <Download className="size-3" />
          </a>
          {onDelete && (
            <button onClick={onDelete} title="删除" className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}>
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      </div>
      {showPreview && (
        <div className="fixed inset-0 bg-stone-950/80 z-50 flex items-center justify-center p-8" onClick={() => setShowPreview(false)}>
          <img src={url} alt={name} className="max-w-full max-h-full object-contain rounded shadow-2xl" />
        </div>
      )}
    </>
  );
}
