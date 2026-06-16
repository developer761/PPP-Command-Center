"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

const CATEGORIES = [
  { value: "coi", label: "Certificate of Insurance (COI)" },
  { value: "w9", label: "W-9" },
  { value: "master_agreement", label: "Master Service Agreement" },
  { value: "vendor_onboarding", label: "Vendor Onboarding / Prequal" },
  { value: "safety", label: "Safety / OSHA" },
  { value: "other", label: "Other" },
] as const;

/**
 * Client-side document upload form for the Commercial CC Account
 * Documents tab. Posts multipart/form-data to
 * `/api/commercial/accounts/[id]/documents`. Server actions don't yet
 * handle File payloads cleanly, so we use a small client form + fetch.
 *
 * Features:
 *   - Drag-and-drop zone (desktop) + tap-to-pick (mobile)
 *   - Inline error surface (per server response)
 *   - Disables the submit button during upload + shows a spinner
 *   - Resets on success + refreshes the route so the new doc appears
 *
 * Mobile patterns:
 *   - File input is full-width with 44px+ tap target
 *   - All inputs are 16px font so iOS Safari doesn't auto-zoom on focus
 *   - Drag-drop UI gracefully degrades to a plain button on touch
 *     devices (no hover state required)
 */
export default function CommercialDocumentUploadForm({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

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
      const res = await fetch(`/api/commercial/accounts/${accountId}/documents`, {
        method: "POST",
        body: data,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        setError(json.detail ?? json.error ?? "Upload failed.");
        return;
      }
      setSuccess(`Uploaded "${json.document.file_name}" (v${json.document.version}).`);
      formEl.reset();
      setPickedFile(null);
      // Hard refresh of the route so the new row shows in the list.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
      <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Upload document</h2>

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
        {/* Drag-drop zone */}
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
            const f = e.dataTransfer.files?.[0];
            if (!f) return;
            if (fileInputRef.current) {
              const dt = new DataTransfer();
              dt.items.add(f);
              fileInputRef.current.files = dt.files;
            }
            handleFile(f);
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
              <div className="text-sm font-semibold text-ppp-charcoal break-all">{pickedFile.name}</div>
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
                className="mt-2 text-[11px] underline text-emerald-700"
              >
                Pick a different file
              </button>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-ppp-charcoal-700">Drag &amp; drop or tap to pick</div>
              <div className="text-[11px] text-ppp-charcoal-500 mt-1">PDF, image, Word, Excel — max 50 MB</div>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx"
            // capture="environment" hints mobile browsers to offer the
            // rear camera as an upload option — Alex can snap a COI or
            // W-9 on-site without leaving the form. Desktop ignores it
            // and falls back to the standard file picker.
            capture="environment"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="category" className={LABEL_CLS}>
              Category *
            </label>
            <select
              id="category"
              name="category"
              defaultValue="coi"
              required
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="expires_at" className={LABEL_CLS}>
              Expires
            </label>
            <input
              id="expires_at"
              name="expires_at"
              type="date"
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div>
          <label htmlFor="notes" className={LABEL_CLS}>
            Notes
          </label>
          <input
            id="notes"
            name="notes"
            type="text"
            placeholder="Optional — e.g. 'renewed 2026-06-14, $2M aggregate'"
            className={INPUT_CLS}
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !pickedFile}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </section>
  );
}
