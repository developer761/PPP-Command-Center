"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SAFE_MULTIPART_BYTES } from "@/lib/commercial/uploads/size-limit";
import { directUploadDocument } from "@/lib/commercial/uploads/direct-upload-client";
import { tooLargeMessage, MAX_UPLOAD_BYTES } from "@/lib/commercial/uploads/limits";

/**
 * Lien-waiver slot for one invoice/milestone. Uploads (or removes) the stored
 * waiver via /api/commercial/invoices/[id]/lien-waiver, then refreshes so the
 * ✓/missing status + the deal's Documents tab both update.
 */
export function LienWaiverUpload({
  invoiceId,
  milestoneId,
  paymentId,
  aiaApplicationId,
  hasWaiver,
  downloadHref,
  fileName,
  compact = false,
  title = "Lien waiver",
  readOnly = false,
  opportunityId,
}: {
  /** Invoice-level waiver (flat invoice, no milestones). */
  invoiceId?: string;
  /** Milestone-level waiver — wins over invoiceId when set. */
  milestoneId?: string;
  /** Payment-level PARTIAL waiver — wins over milestoneId/invoiceId when set. */
  paymentId?: string;
  /** AIA application waiver — on a progress-billed job the requisition IS the
   *  payment request, so the waiver belongs to the application, not to an
   *  invoice that may not exist (Stephanie 2026-08-20). */
  aiaApplicationId?: string;
  hasWaiver: boolean;
  downloadHref?: string | null;
  fileName?: string | null;
  /** Denser layout for inline milestone / payment rows. */
  compact?: boolean;
  /** Slot label — e.g. "Final lien waiver" / "Partial waiver". */
  title?: string;
  /** Download-only (e.g. the invoice is void) — hides upload + remove. */
  readOnly?: boolean;
  /**
   * The deal this slot belongs to. Required for waivers over ~4 MB: those
   * cannot be posted through the route (Vercel caps the body), so they go
   * browser → Storage via the Documents path and are then linked by id.
   * Without it the component can still take small files, and says so.
   */
  opportunityId?: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const endpoint = aiaApplicationId
    ? `/api/commercial/aia/${aiaApplicationId}/lien-waiver`
    : paymentId
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

  /**
   * Bytes straight to Storage, then file the resulting document as the waiver.
   * Two steps rather than one because only the first can carry a large body —
   * and the second is a few hundred bytes of JSON, so it is never the problem.
   */
  async function sendLarge(file: File, oppId: string) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      const up = await directUploadDocument({
        parentType: "opportunity",
        parentId: oppId,
        file,
        category: "lien_waiver",
        notes: title,
        onProgress: (fraction) => setProgress(fraction),
      }).promise;
      if (!up.ok) {
        setError(up.canceled ? null : up.error);
        return;
      }
      const documentId = (up.document as { id?: string } | null)?.id;
      if (!documentId) {
        setError("The upload finished but came back without an id — tell Karan.");
        return;
      }
      const target = aiaApplicationId ? "aia" : paymentId ? "payment" : milestoneId ? "milestone" : "invoice";
      const id = aiaApplicationId ?? paymentId ?? milestoneId ?? invoiceId;
      const res = await fetch("/api/commercial/lien-waivers/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, id, document_id: documentId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The file IS uploaded and sitting in Documents; only the link failed.
        setError(`${json.error ?? "Could not file it as the waiver."} The file is on the Documents tab.`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
      setProgress(null);
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
                e.target.value = "";
                // Small enough to post through the route: unchanged path.
                if (f.size <= SAFE_MULTIPART_BYTES) {
                  const fd = new FormData();
                  fd.append("file", f);
                  void send(fd);
                  return;
                }
                // Too big for a serverless request body. It used to be refused
                // here with advice to put it on the Documents tab — where it
                // landed but never linked, so the slot still read "Missing".
                // Now it takes the same route the Documents tab does, and the
                // result is filed as the waiver.
                if (f.size > MAX_UPLOAD_BYTES) { setError(tooLargeMessage(f.size, "as a lien waiver")); return; }
                if (!opportunityId) {
                  setError(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB. Attach it from the deal's Documents / Files tab — this slot can only take files under ${(SAFE_MULTIPART_BYTES / 1024 / 1024).toFixed(0)} MB here.`);
                  return;
                }
                void sendLarge(f, opportunityId);
              }}
              className="block text-[12px] text-ppp-charcoal-600 file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12px] file:font-semibold file:bg-ppp-blue-600 file:text-white hover:file:bg-ppp-blue-700 file:min-h-[44px] file:touch-manipulation cursor-pointer"
            />
            {hasWaiver && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  // A signed lien waiver is a legal document — the GC will not
                  // release payment without it, and there is no restore screen
                  // for commercial_documents. Of everything on this page this
                  // is the one worth a sentence before it goes.
                  if (
                    !window.confirm(
                      "Remove the signed lien waiver? It is a legal document and this can't be undone from here.",
                    )
                  )
                    return;
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
          {busy && <p className="text-[11px] text-ppp-charcoal-400 mt-2">{progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : "Uploading…"}</p>}
          {error && <p className="text-[11px] text-rose-700 mt-2">{error}</p>}
        </>
      )}
    </div>
  );
}
