"use client";

import { useMemo, useRef, useState } from "react";
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

/** Mirror of lib/commercial/accounts/documents.ts sanitizeFileName so the
 *  preview shows EXACTLY what the server will save. Duplicated here
 *  because importing a server-only lib into a client component throws. */
function previewSanitized(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || "untitled"
  );
}

type ExpiryMode = "auto" | "custom" | "none";

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
  // "auto" = 1yr default for renewable categories (COI / W-9 / MSA).
  // "custom" = user picks a date below.
  // "none" = explicit no-expiry (sent as null to the server).
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>("auto");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  // AbortController for the in-flight fetch — lets Cancel actually
  // interrupt a slow upload (Karan: "give users a way out — phones on
  // LTE shouldn't trap them in a 4-minute wait"). Recreated per submit;
  // ref lifetime survives re-renders.
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = (file: File | null) => {
    setError(null);
    setSuccess(null);
    // Block obvious bad picks early so the user gets feedback BEFORE
    // they hit Upload — saves a roundtrip on phones with slow uploads.
    if (file && file.size === 0) {
      setError("That file is empty — pick another.");
      setPickedFile(null);
      return;
    }
    if (file && file.size > 50 * 1024 * 1024) {
      setError(`That file is ${Math.round(file.size / 1024 / 1024)} MB — max is 50 MB. Try compressing or splitting.`);
      setPickedFile(null);
      return;
    }
    setPickedFile(file);
  };

  // Sanitized preview + HEIC heads-up update reactively when the file changes.
  const sanitizedPreview = useMemo(() => {
    if (!pickedFile) return null;
    const sanitized = previewSanitized(pickedFile.name);
    const changed = sanitized !== pickedFile.name.toLowerCase();
    return { sanitized, changed };
  }, [pickedFile]);

  const heicWarning = useMemo(() => {
    if (!pickedFile) return null;
    const isHeic =
      pickedFile.type === "image/heic" ||
      pickedFile.name.toLowerCase().endsWith(".heic") ||
      pickedFile.name.toLowerCase().endsWith(".heif");
    return isHeic
      ? "HEIC photos don't open on Windows or older Android — consider converting to JPG in your Photos app first."
      : null;
  }, [pickedFile]);

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
    // Translate the expiry mode radio into what the API expects:
    //   "auto"   → omit expires_at entirely → server applies category default
    //   "custom" → send the date from the hidden input
    //   "none"   → send empty string (server treats as explicit null)
    if (expiryMode === "auto") {
      data.delete("expires_at");
    } else if (expiryMode === "none") {
      data.set("expires_at", "");
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/commercial/accounts/${accountId}/documents`, {
        method: "POST",
        body: data,
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        // Concurrent-upload race — surface a refresh prompt rather than a
        // confusing constraint-name dump.
        if (typeof json.error === "string" && json.error.includes("Someone else uploaded")) {
          setError("Another user just uploaded to this category. Refresh the page to see their version, then re-upload yours as a new version.");
        } else {
          setError(json.detail ?? json.error ?? "Upload failed.");
        }
        return;
      }
      const d = json.document;
      const versionLine = d.version === 1
        ? `Uploaded "${d.file_name}" as v1 — first in this category.`
        : `Uploaded "${d.file_name}" as v${d.version} — prior version archived.`;
      setSuccess(versionLine);
      formEl.reset();
      setPickedFile(null);
      setExpiryMode("auto");
      // Hard refresh of the route so the new row shows in the list.
      router.refresh();
    } catch (err) {
      // AbortError is the user clicking Cancel — show a friendly message
      // instead of a generic network-error scare.
      if (err instanceof Error && err.name === "AbortError") {
        setError("Upload cancelled. Pick the file again to retry.");
      } else {
        setError(err instanceof Error ? err.message : "Network error.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
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

        {/* Sanitized filename preview — server lowercases + strips spaces
            and special chars. Showing this BEFORE upload prevents the
            "wait, why did my filename change?" surprise. Only renders
            when sanitization actually changed something. */}
        {sanitizedPreview?.changed && (
          <div className="text-[11px] text-ppp-charcoal-500 bg-ppp-charcoal-50 rounded-lg px-3 py-2">
            Will be saved as <strong className="text-ppp-charcoal-700">{sanitizedPreview.sanitized}</strong> (spaces + special chars stripped for safe storage).
          </div>
        )}
        {heicWarning && (
          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {heicWarning}
          </div>
        )}

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
            <label className={LABEL_CLS}>Expiry</label>
            {/* 3-mode expiry picker. "Auto" is the default — COI / W-9 /
                MSA get a 1-year default from the server; other categories
                get no expiry. "Custom" reveals a date picker. "No expiry"
                explicitly skips the alert system (for evergreen docs). */}
            <div className="flex gap-1.5 mb-2" role="radiogroup" aria-label="Expiry mode">
              {([
                { key: "auto", label: "Auto" },
                { key: "custom", label: "Pick date" },
                { key: "none", label: "No expiry" },
              ] as const).map((o) => {
                const active = expiryMode === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setExpiryMode(o.key)}
                    className={`flex-1 px-2 py-2 rounded-lg text-[12px] font-medium border transition-colors min-h-[40px] touch-manipulation ${
                      active
                        ? "bg-emerald-600 text-white border-emerald-600"
                        : "bg-white text-ppp-charcoal-700 border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {expiryMode === "custom" && (
              <input
                id="expires_at"
                name="expires_at"
                type="date"
                required
                className={INPUT_CLS}
              />
            )}
            {expiryMode === "auto" && (
              <p className="text-[10px] text-ppp-charcoal-500">
                COI / W-9 / MSA default to 1 year. Other categories default to no expiry.
              </p>
            )}
            {expiryMode === "none" && (
              <p className="text-[10px] text-ppp-charcoal-500">
                Document won&apos;t appear in expiring-soon alerts. Use for evergreen records.
              </p>
            )}
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

        <div className="flex justify-end gap-2">
          {busy && (
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-200 bg-white text-rose-700 text-sm font-medium hover:bg-rose-50 hover:border-rose-300 min-h-[44px] sm:min-h-0 touch-manipulation"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !pickedFile}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0 touch-manipulation"
          >
            {busy ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin" aria-hidden>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Uploading…
              </>
            ) : "Upload"}
          </button>
        </div>
      </form>
    </section>
  );
}
