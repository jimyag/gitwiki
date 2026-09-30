import { useStore } from "../store";
import { X, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

export function UploadBar() {
  const uploads = useStore(s => s.uploads);
  const removeUpload = useStore(s => s.removeUpload);

  if (uploads.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 space-y-2 w-72">
      {uploads.map(u => (
        <div
          key={u.id}
          className="bg-white rounded-lg shadow-lg border border-stone-200 overflow-hidden"
        >
          <div className="px-3 py-2.5 flex items-center gap-2">
            {u.status === "uploading" && <Loader2 className="size-3.5 text-emerald-600 animate-spin shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="size-3.5 text-emerald-600 shrink-0" />}
            {u.status === "error" && <AlertCircle className="size-3.5 text-red-500 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-stone-900 truncate">{u.filename}</div>
              {u.status === "uploading" && <div className="text-[10px] text-stone-500">{u.pct}%</div>}
              {u.status === "error" && <div className="text-[10px] text-red-600 truncate">{u.error}</div>}
            </div>
            <button
              onClick={() => removeUpload(u.id)}
              className="p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 shrink-0"
            >
              <X className="size-3" />
            </button>
          </div>
          {u.status === "uploading" && (
            <div className="h-0.5 bg-stone-100">
              <div
                className="h-full bg-emerald-500 transition-all duration-150"
                style={{ width: `${u.pct}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
