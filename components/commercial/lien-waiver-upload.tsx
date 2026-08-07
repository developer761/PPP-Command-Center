"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Lien-waiver slot for one invoice/milestone. Uploads (or removes) the stored
 * waiver via /api/commercial/invoices/[id]/lien-waiver, then refreshes so the
 * ✓/missing status + the deal's Documents tab both update.
 */
export function LienWaiverUpload({
  invoiceId,
  milestoneId,
  paymentId,
  hasWaiver,
  downloadHref,
  fileName,
  compact = false,
  title = "Lien waiver",
  readOnly = false,
}: {
  /** Invoice-level waiver (flat invoice, no milestones). */
  invoiceId?: string;
  /** Milestone-level waiver — wins over invoiceId when set. */
  milestoneId?: string;
  /** Payment-level PARTIAL waiver — wins over milestoneId/invoiceId when set. */
  paymentId?: string;
  hasWaiver: boolean;
  downloadHref?: string | null;
  fileName?: string | null;
  /** Denser layout for inline milestone / payment rows. */
  compact?: boolean;
  /** Slot label — e.g. "Final lien waiver" / "Partial waiver". */
  title?: string;
  /** Download-only (e.g. the invoice is void) — hides upload + remove. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = paymentId
    ? `/api/commercial/payments/${paymentId}/lien-waiver`
    : milestoneId
    ? `/api/commercial/milestones/${milestoneId}/lien-waiver`
    : `/api/commercial/invoices/${invoiceId}/lien-waiver`;

  async function send(fd: FormData) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST", body: fd });
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
    <div className={`rounded-lg border border-ppp-charcoal-100 bg-surface ${compact ? "p-2.5" : "p-3.5"}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[12.5px] font-semibold text-ppp-charcoal">{title}</span>
        {hasWaiver ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wide text-emerald-700">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            On file
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wide text-amber-700">Missing</span>
        )}
      </div>

      {hasWaiver && downloadHref && (
        <a href={downloadHref} className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-ppp-charcoal-50 min-h-[44px] group mb-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
          <span className="text-[12px] font-medium text-ppp-charcoal truncate group-hover:text-ppp-blue-800">{fileName || "Download waiver"}</span>
        </a>
      )}

      {readOnly ? (
        !hasWaiver && <p className="text-[11px] text-ppp-charcoal-400">No waiver on file.</p>
      ) : (
        <>
          {!compact && <p className="text-[11px] text-ppp-charcoal-500 mb-2">Upload the signed waiver (PDF or image). It also lands in this opportunity&rsquo;s Documents.</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileRef}
              type="file"
          aria-label="Upload signed lien waiver"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const fd = new FormData();
                fd.append("file", f);
                void send(fd);
              }}
              className="block text-[12px] text-ppp-charcoal-600 file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12px] file:font-semibold file:bg-ppp-blue-600 file:text-white hover:file:bg-ppp-blue-700 file:min-h-[44px] file:touch-manipulation cursor-pointer"
            />
            {hasWaiver && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const fd = new FormData();
                  fd.append("remove", "1");
                  void send(fd);
                }}
                className="text-[11.5px] font-medium text-ppp-charcoal-500 hover:text-rose-700 min-h-[44px] px-2"
              >
                Remove
              </button>
            )}
          </div>
          {busy && <p className="text-[11px] text-ppp-charcoal-400 mt-2">Uploading…</p>}
          {error && <p className="text-[11px] text-rose-700 mt-2">{error}</p>}
        </>
      )}
    </div>
  );
}
