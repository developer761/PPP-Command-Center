"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

/** Mirror of MAX_UPLOAD_BYTES in lib/commercial/documents/db.ts (100 MB).
 *  Duplicated because importing a server-only lib into a client component
 *  errors at build time. Keep in sync — if either changes, also audit the
 *  bucket setting in the Supabase console. */
const CLIENT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Mirror of DOCUMENT_CATEGORIES + labels from lib/commercial/documents/
 *  categories.ts. Duplicated for the same server-only-import reason. */
const CATEGORIES = [
  { value: "bid_set", label: "Bid Set (Plans + Specs)" },
  { value: "rfi", label: "RFI" },
  { value: "meeting_minutes", label: "Meeting Minutes" },
  { value: "permit", label: "Permit" },
  { value: "insurance", label: "Insurance (per-job)" },
  { value: "contract", label: "Contract" },
  { value: "site_photo", label: "Site Photo" },
  { value: "correspondence", label: "Correspondence" },
  { value: "other", label: "Other" },
] as const;

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

/**
 * Polymorphic file uploader for Phase C documents. Same shape as the
 * account-docs uploader but scoped by (parentType, parentId) — will
 * serve projects too when Phase H ships.
 *
 * Design choices:
 *  - Single-file upload in v1 (bulk drag-drop deferred to a polish pass).
 *  - AbortController so users can cancel mid-flight — big bid PDFs can
 *    take a while.
 *  - Camera capture via `capture="environment"` on the file input for
 *    mobile site photos.
 *  - Notes optional, category picker required (defaults to "Other" so
 *    picker anxiety never blocks the upload).
 */
export function CommercialFilesUploadForm({
  parentType,
  parentId,
}: {
  parentType: "opportunity" | "project";
  parentId: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>("other");
  const [notes, setNotes] = useState<string>("");

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setSelectedFile(f);
    setError(null);
    if (f && f.size > CLIENT_MAX_UPLOAD_BYTES) {
      setError(`File too big (${Math.round(f.size / 1024 / 1024)} MB). Max 100 MB.`);
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!selectedFile) {
      setError("Pick a file first.");
      return;
    }
    if (selectedFile.size <= 0) {
      setError("That file is empty.");
      return;
    }
    if (selectedFile.size > CLIENT_MAX_UPLOAD_BYTES) {
      setError(`File too big (${Math.round(selectedFile.size / 1024 / 1024)} MB). Max 100 MB.`);
      return;
    }

    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("category", category);
    if (notes.trim()) fd.append("notes", notes.trim());

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const url =
        parentType === "opportunity"
          ? `/api/commercial/opportunities/${parentId}/documents`
          : `/api/commercial/projects/${parentId}/documents`;
      const res = await fetch(url, {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed." }));
        throw new Error(body.error || `Upload failed (${res.status}).`);
      }
      // Reset + refresh so the new row shows up in the list below.
      formRef.current?.reset();
      setSelectedFile(null);
      setNotes("");
      setCategory("other");
      router.refresh();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setError("Cancelled.");
      } else {
        setError((err as Error).message || "Upload failed.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const previewName = selectedFile ? previewSanitized(selectedFile.name) : null;
  const previewMB = selectedFile ? (selectedFile.size / 1024 / 1024).toFixed(2) : null;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-ppp-charcoal">Upload a file</h3>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-0.5">
            PDFs, images, Word, Excel, or plain text. Up to 100 MB.
          </p>
          {/* Google Drive silently recompresses PDFs on download (per
              Brendan/Katie 2026-07-10). Note it here so users upload
              the raw file, not a Drive re-share. Dropbox doesn't do this. */}
          <p className="text-[10.5px] text-amber-700 mt-1 flex items-start gap-1">
            <span aria-hidden>ⓘ</span>
            <span>
              Google Drive recompresses PDFs on download — upload the raw file, not a Drive link.
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL_CLS}>File</span>
          <input
            type="file"
            name="file"
            onChange={onFile}
            /* capture="environment" enables direct-camera-shot on mobile
               (iOS + Android). Desktop browsers ignore it. */
            capture="environment"
            accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.doc,.docx,.xls,.xlsx,.txt"
            className="block w-full text-sm text-ppp-charcoal file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-semibold file:bg-ppp-charcoal-100 file:text-ppp-charcoal hover:file:bg-ppp-charcoal-200"
            required
          />
          {previewName && (
            <span className="block text-[10.5px] text-ppp-charcoal-500 mt-1 truncate">
              Saved as {previewName} · {previewMB} MB
            </span>
          )}
        </label>
        <label className="block">
          <span className={LABEL_CLS}>Category</span>
          <select
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={LABEL_CLS}>Notes (optional)</span>
        <input
          type="text"
          name="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          placeholder="Add a short note visible on the file row."
          className={INPUT_CLS}
        />
      </label>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !selectedFile}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/25 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[40px] touch-manipulation"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
