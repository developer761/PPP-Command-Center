"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Invoice attachments panel — arbitrary files attached to ONE invoice (a signed
 * contract copy, a photo, a spec sheet). Uploads/removes via
 * /api/commercial/invoices/[id]/attachments, then refreshes so the list + the
 * deal Documents tab both update. Blue to match the invoice detail chrome.
 */
export function InvoiceAttachments({
  invoiceId,
  attachments,
  canEdit,
}: {
  invoiceId: string;
  attachments: { id: string; file_name: string | null }[];
  /** Hide upload/remove on a void invoice (read-only). */
  canEdit: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/commercial/invoices/${invoiceId}/attachments`;

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
    <div>
      {attachments.length > 0 ? (
        <ul className="divide-y divide-ppp-charcoal-100 mb-2">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2">
              <a
                href={`/api/commercial/documents/${a.id}/download`}
                className="flex items-center gap-2 min-w-0 py-1 rounded hover:bg-ppp-charcoal-50 group flex-1"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                <span className="text-[12.5px] font-medium text-ppp-charcoal truncate group-hover:text-ppp-blue-800">{a.file_name || "Attachment"}</span>
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
                  className="text-[11.5px] font-medium text-ppp-charcoal-400 hover:text-rose-700 min-h-[44px] px-2 shrink-0"
                  aria-label={`Remove ${a.file_name || "attachment"}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-ppp-charcoal-500 mb-2">No files attached yet.</p>
      )}

      {canEdit && (
        <>
          <input
            ref={fileRef}
            type="file"
          aria-label="Attach file to invoice"
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
          <p className="text-[11px] text-ppp-charcoal-500 mt-1.5">PDF or image. Attachments also land in this opportunity&rsquo;s Documents.</p>
        </>
      )}
      {busy && <p className="text-[11px] text-ppp-charcoal-400 mt-2">Uploading…</p>}
      {error && <p className="text-[11px] text-rose-700 mt-2">{error}</p>}
    </div>
  );
}
