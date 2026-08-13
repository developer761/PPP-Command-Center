"use client";

import { useRef, useState } from "react";
import { DOCUMENT_CATEGORIES, documentCategoryLabel } from "@/lib/commercial/documents/categories";
import { useRouter } from "next/navigation";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { directUploadDocument } from "@/lib/commercial/uploads/direct-upload-client";

/** Mirror of MAX_UPLOAD_BYTES in lib/commercial/documents/db.ts (100 MB).
 *  Duplicated because importing a server-only lib into a client component
 *  errors at build time. Keep in sync — if either changes, also audit the
 *  bucket setting in the Supabase console. */
const CLIENT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Files at/above this size can't go through the multipart API route —
 *  Vercel caps serverless request bodies at ~4.5 MB. Above the threshold we
 *  upload DIRECTLY to Supabase Storage via a signed URL (R6b). Set well under
 *  4.5 MB for headroom (multipart boundary + fields add overhead). */
const DIRECT_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

/**
 * The canonical category list — imported, never mirrored.
 *
 * This file used to carry its own copy "for the same server-only-import
 * reason". That reason had lapsed: categories.ts is pure data with no imports
 * at all, so a client component can read it directly. The copy had already
 * drifted — `work_order` was in the real list and missing here, so nobody
 * could file a document under it — and a mirror in the account-side form is
 * exactly how Brendan's 2026-08-12 category change failed to reach the screen.
 * One list, one place.
 */
const CATEGORIES = DOCUMENT_CATEGORIES.map((value) => ({
  value,
  label: documentCategoryLabel(value),
}));

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
  defaultCategory = "other",
}: {
  parentType: "opportunity" | "project";
  parentId: string;
  /** Preselect the category picker (e.g. a Project sub-tab presets its tool's
   *  bucket). The user can still change it. */
  defaultCategory?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const directHandleRef = useRef<{ cancel: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>(defaultCategory);
  const [notes, setNotes] = useState<string>("");
  // Non-null only during a large (direct-to-Storage) upload — drives the % bar.
  const [progress, setProgress] = useState<number | null>(null);

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
    directHandleRef.current?.cancel();
    setBusy(false);
    setProgress(null);
  };

  const resetAfterUpload = () => {
    formRef.current?.reset();
    setSelectedFile(null);
    setNotes("");
    setCategory("other");
    router.refresh();
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

    // Large files can't fit through Vercel's ~4.5 MB serverless body cap — send
    // them straight to Supabase Storage via a signed URL (R6b), with a live %.
    if (selectedFile.size > DIRECT_UPLOAD_THRESHOLD) {
      setBusy(true);
      setProgress(0);
      const handle = directUploadDocument({
        parentType,
        parentId,
        file: selectedFile,
        category,
        notes: notes.trim() || null,
        onProgress: (f) => setProgress(f),
      });
      directHandleRef.current = handle;
      try {
        const result = await handle.promise;
        if (result.ok) {
          resetAfterUpload();
        } else {
          setError(result.canceled ? "Cancelled." : result.error);
        }
      } finally {
        setBusy(false);
        setProgress(null);
        directHandleRef.current = null;
      }
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
      resetAfterUpload();
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
      className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3"
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

      {progress !== null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-ppp-charcoal-100">
          <div
            className="h-full rounded-full bg-cc-brand-500 transition-[width] duration-150"
            style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !selectedFile}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[40px] touch-manipulation shadow-sm shadow-cc-brand-600/25 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? progress !== null
              ? `Uploading… ${Math.round(progress * 100)}%`
              : "Uploading…"
            : "Upload"}
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
