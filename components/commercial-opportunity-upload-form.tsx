"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Plans & Specs upload form for the Commercial CC Opportunity detail
 * page. Posts multipart/form-data to
 * `/api/commercial/opportunities/[id]/attachments`.
 *
 * Mirrors the accounts-document upload component but simpler — no
 * category enum + no expiry date. Files are arbitrary (RFP, plans,
 * spec book, proposal_v3.pdf). The lib auto-versions when the same
 * filename re-uploads.
 *
 * Mobile patterns:
 *   - File input full-width, 44px+ tap target
 *   - All inputs 16px font so iOS Safari doesn't auto-zoom on focus
 *   - Drag-drop degrades gracefully to tap-to-pick on touch
 */
export default function CommercialOpportunityUploadForm({ oppId }: { oppId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // Auto-dismiss success banner after 5s — user scrolling the file list
  // shouldn't miss the confirmation, but it shouldn't linger forever.
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [success]);

  const handleFile = (file: File | null) => {
    setError(null);
    setSuccess(null);
    setPickedFile(file);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !formRef.current) return;
    setError(null);
    setSuccess(null);
    const formEl = formRef.current;
    const data = new FormData(formEl);
    if (!(data.get("file") instanceof File) || (data.get("file") as File).size === 0) {
      setError("Pick a file first.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/commercial/opportunities/${oppId}/attachments`, {
        method: "POST",
        body: data,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.detail ?? json.error ?? "Upload failed.");
        return;
      }
      const versionTag = json.attachment?.version > 1 ? ` (v${json.attachment.version})` : "";
      setSuccess(`Uploaded "${json.attachment.file_name}"${versionTag}.`);
      formEl.reset();
      setPickedFile(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
      <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Upload file</h2>
      <p className="text-[11px] text-ppp-charcoal-500 mb-3">
        Plans, specs, RFPs, proposals — any file relevant to this bid. Re-uploading the
        same filename auto-archives the prior version and stacks history.
      </p>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700 mb-3">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700 mb-3">
          {success}
        </div>
      )}

      <form ref={formRef} onSubmit={handleSubmit} className="space-y-3">
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = e.dataTransfer.files;
            const f = files?.[0];
            if (!f) return;
            if (fileInputRef.current) {
              const dt = new DataTransfer();
              dt.items.add(f);
              fileInputRef.current.files = dt.files;
            }
            handleFile(f);
            if (files && files.length > 1) {
              // Quietly inform the user the rest were ignored so they
              // can retry the others one at a time. Better than silent drop.
              setSuccess(`Picked "${f.name}". ${files.length - 1} other file${files.length > 2 ? "s" : ""} ignored — upload one at a time.`);
            }
          }}
          className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors min-h-[88px] flex flex-col items-center justify-center ${
            dragOver
              ? "border-emerald-600 bg-emerald-50"
              : pickedFile
              ? "border-emerald-300 bg-emerald-50/40"
              : "border-ppp-charcoal-200 bg-ppp-charcoal-50/30 hover:border-emerald-300 hover:bg-emerald-50/30"
          }`}
        >
          {pickedFile ? (
            <>
              <div className="text-sm font-semibold text-ppp-charcoal break-all">
                {pickedFile.name}
              </div>
              <div className="text-[11px] text-ppp-charcoal-500 mt-1">
                {(pickedFile.size / 1024 / 1024).toFixed(2)} MB · {pickedFile.type || "unknown"}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (fileInputRef.current) fileInputRef.current.value = "";
                  setPickedFile(null);
                }}
                className="mt-2 text-xs underline text-emerald-700 min-h-[44px] inline-flex items-center px-2 touch-manipulation"
              >
                Pick a different file
              </button>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-ppp-charcoal-700">
                <span className="sm:hidden">Tap to choose a file</span>
                <span className="hidden sm:inline">Drag &amp; drop or click to pick</span>
              </div>
              <div className="text-[11px] text-ppp-charcoal-500 mt-1">
                PDF, image, Word, Excel — max 50 MB
              </div>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div>
          <label htmlFor="notes" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            maxLength={500}
            placeholder="Optional — e.g. 'Final proposal v3 from customer'"
            className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 resize-y min-h-[60px]"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !pickedFile}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </section>
  );
}
