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
          className="overflow-hidden rounded-xl bg-raised shadow-pop animate-pop-in"
        >
          <div className="px-3 py-2.5 flex items-center gap-2.5">
            {u.status === "uploading" && <Loader2 className="size-4 text-accent animate-spin shrink-0" />}
            {u.status === "done" && <CheckCircle2 className="size-4 text-accent shrink-0" />}
            {u.status === "error" && <AlertCircle className="size-4 text-red-500 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-fg truncate">{u.filename}</div>
              {u.status === "uploading" && <div className="text-[11px] tabular-nums text-fg-muted">{u.pct}%</div>}
              {u.status === "error" && <div className="text-[11px] text-red-600 truncate dark:text-red-400">{u.error}</div>}
            </div>
            <button
              onClick={() => removeUpload(u.id)}
              className="p-1 rounded-md text-fg-subtle transition-colors hover:text-fg hover:bg-shade shrink-0"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {u.status === "uploading" && (
            <div className="h-0.5 bg-shade">
              <div
                className="h-full bg-accent transition-all duration-150"
                style={{ width: `${u.pct}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
