import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Paperclip, Copy, X, ImageIcon } from "lucide-react";
import { toast } from "sonner";

export function AssetsPanel({ onClose }: { onClose: () => void }) {
  const currentRepo = useStore(s => s.currentRepo);
  const pageId = useStore(s => s.currentPageId);
  const [assets, setAssets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentRepo || !pageId) return;
    setLoading(true);
    api.listAssets(currentRepo, pageId)
      .then(setAssets)
      .catch(() => setAssets([]))
      .finally(() => setLoading(false));
  }, [currentRepo, pageId]);

  const copyRef = (name: string) => {
    navigator.clipboard.writeText(`![](assets/${name})`).then(
      () => toast.success("已复制图片引用"),
      () => toast.error("复制失败")
    );
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-xl w-[480px] max-h-[70vh] shadow-2xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-stone-200 flex items-center gap-2">
          <Paperclip className="size-4 text-stone-400" />
          <div className="text-sm font-medium text-stone-900">附件</div>
          <div className="text-xs text-stone-400">{assets.length} 个</div>
          <button onClick={onClose} className="ml-auto p-1 rounded text-stone-400 hover:text-stone-600 hover:bg-stone-100">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {loading && <div className="py-8 text-center text-xs text-stone-400">加载中…</div>}
          {!loading && assets.length === 0 && (
            <div className="py-12 text-center text-xs text-stone-400 space-y-2">
              <ImageIcon className="size-8 mx-auto text-stone-300" />
              <div>本页还没有附件</div>
              <div className="text-[10px]">在编辑器里直接粘贴图片即可上传</div>
            </div>
          )}
          {!loading && assets.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {assets.map(name => (
                <AssetCard key={name} repo={currentRepo!} pageId={pageId!} name={name} onCopy={() => copyRef(name)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AssetCard({ repo, pageId, name, onCopy }: {
  repo: string; pageId: string; name: string; onCopy: () => void;
}) {
  const url = api.assetUrl(repo, pageId, name);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  const [showPreview, setShowPreview] = useState(false);

  return (
    <>
      <div className="group relative rounded-md border border-stone-200 overflow-hidden bg-stone-50 hover:border-stone-300 transition">
        <button
          onClick={() => isImage && setShowPreview(true)}
          className="block w-full aspect-square overflow-hidden text-left"
        >
          {isImage ? (
            <img src={url} alt={name} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Paperclip className="size-6 text-stone-400" />
            </div>
          )}
        </button>
        <div className="p-2 bg-white border-t border-stone-100 flex items-center gap-1">
          <span className="text-[10px] text-stone-500 truncate flex-1 font-mono" title={name}>{name}</span>
          <button
            onClick={onCopy}
            title="复制 ![](assets/…) 引用"
            className="p-1 rounded text-stone-400 hover:text-emerald-600 hover:bg-emerald-50 transition"
          >
            <Copy className="size-3" />
          </button>
        </div>
      </div>
      {showPreview && isImage && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-center justify-center p-8 backdrop-blur-sm" onClick={() => setShowPreview(false)}>
          <img src={url} alt={name} className="max-w-full max-h-full object-contain rounded shadow-2xl" />
        </div>
      )}
    </>
  );
}
