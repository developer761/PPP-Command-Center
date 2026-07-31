"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Logo / signature uploader for the Operating Company settings page (Phase 0B).
 * Posts to /api/commercial/operating-company/asset, then refreshes so the
 * "on file" state + every generated PDF picks up the new image.
 */
export function BrandAssetUpload({
  kind,
  label,
  hint,
  hasAsset,
}: {
  kind: "logo" | "signature";
  label: string;
  hint: string;
  hasAsset: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(fd: FormData) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/commercial/operating-company/asset", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Upload failed.");
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-surface p-3.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[12px] font-semibold text-ppp-charcoal">{label}</span>
        {hasAsset && (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wide text-emerald-700">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            On file
          </span>
        )}
      </div>
      <p className="text-[11px] text-ppp-charcoal-500 mb-2.5">{hint}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append("kind", kind);
            fd.append("file", f);
            void submit(fd);
          }}
          className="block text-[12px] text-ppp-charcoal-600 file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12px] file:font-semibold file:bg-cc-brand-600 file:text-white hover:file:bg-cc-brand-700 file:min-h-[40px] file:touch-manipulation cursor-pointer"
        />
        {hasAsset && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const fd = new FormData();
              fd.append("kind", kind);
              fd.append("clear", "1");
              void submit(fd);
            }}
            className="text-[11.5px] font-medium text-ppp-charcoal-500 hover:text-rose-700 min-h-[40px] px-2"
          >
            Remove
          </button>
        )}
      </div>
      {busy && <p className="text-[11px] text-ppp-charcoal-400 mt-2">Uploading…</p>}
      {error && <p className="text-[11px] text-rose-700 mt-2">{error}</p>}
    </div>
  );
}
