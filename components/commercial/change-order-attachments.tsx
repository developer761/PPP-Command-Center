"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-change-order documents (signed CO PDFs / backup). Uploads/removes via
 * /api/commercial/change-orders/[id]/attachments, then refreshes so the row's
 * list + the deal Documents → Change Orders box both update. Mirrors
 * InvoiceAttachments (same UX + the scoped-remove backend).
 */
export function ChangeOrderAttachments({
  changeOrderId,
  attachments,
  canEdit,
}: {
  changeOrderId: string;
  attachments: { id: string; file_name: string | null }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/commercial/change-orders/${changeOrderId}/attachments`;

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
    <div className="mt-1.5">
      {attachments.length > 0 && (
        <ul className="divide-y divide-ppp-charcoal-50 mb-1.5">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
              <a
                href={`/api/commercial/documents/${a.id}/download`}
                className="flex items-center gap-2 min-w-0 py-1 rounded hover:bg-ppp-charcoal-50 group flex-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                <span className="text-[12px] font-medium text-ppp-charcoal truncate group-hover:text-cc-brand-800">{a.file_name || "Attachment"}</span>
              </a>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const fd = new FormData();
                    fd.append("remove_document_id", a.id);
                    void send(fd);
                  }}
                  className="text-[11px] font-medium text-ppp-charcoal-400 hover:text-rose-700 min-h-[44px] px-2 shrink-0"
                  aria-label={`Remove ${a.file_name || "attachment"}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const fd = new FormData();
            fd.append("file", f);
            void send(fd);
          }}
          className="block text-[11.5px] text-ppp-charcoal-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[11.5px] file:font-semibold file:bg-cc-brand-600 file:text-white hover:file:bg-cc-brand-700 file:min-h-[44px] file:touch-manipulation cursor-pointer"
        />
      )}
      {attachments.length === 0 && !canEdit && <p className="text-[11px] text-ppp-charcoal-400">No documents attached.</p>}
      {busy && <p className="text-[11px] text-ppp-charcoal-400 mt-1">Uploading…</p>}
      {error && <p className="text-[11px] text-rose-700 mt-1">{error}</p>}
    </div>
  );
}
