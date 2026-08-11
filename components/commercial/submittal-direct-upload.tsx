"use client";

/**
 * Submittal direct-upload button. Renders a "Upload PDF" button that
 * opens a file picker; on select, POSTs the file to the opp attachments
 * endpoint with `submittal_id` pre-set so the attachment is auto-linked
 * to this submittal in one round-trip. No more "upload to Plans & Specs
 * first, then come back to link" — Karan 2026-07-05.
 *
 * Uses the same MIME + size validation the /api/.../attachments route
 * enforces server-side; mirrors it client-side so the user gets
 * instant feedback on obvious rejects instead of a 415/413 round-trip.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  opportunityId: string;
  submittalId: string;
  /** Whether the button is enabled. Voided submittals (or missing
   *  writeable rights) render a disabled state instead. */
  disabled?: boolean;
  disabledReason?: string;
};

// Mirrors ALLOWED_MIME_TYPES on the server. Keep in sync manually —
// the client component can't import from the accounts/documents.ts
// server-side helper without pulling non-browser deps.
const ACCEPTED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
];
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export default function SubmittalDirectUpload({
  opportunityId,
  submittalId,
  disabled = false,
  disabledReason,
}: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPickClick = () => {
    setError(null);
    inputRef.current?.click();
  };

  // F1 (Katie #9, 2026-08): accept MULTIPLE files in one pick. Each still uploads
  // as its own request (the endpoint takes one file), so we validate the batch,
  // upload the good ones one at a time with a running "n of m" count, refresh
  // ONCE at the end, and report exactly which files were skipped + why — a bad
  // file (too big / wrong type / server reject) never aborts the whole batch.
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset the input so re-picking the same file(s) still triggers change.
    e.target.value = "";
    if (files.length === 0) return;

    // Split into uploadable vs rejected up front (mirrors the server's guards).
    const valid: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (f.size > MAX_UPLOAD_BYTES) rejected.push(`${f.name} — over ${MAX_UPLOAD_MB} MB`);
      else if (f.type && !ACCEPTED_MIME.includes(f.type)) rejected.push(`${f.name} — type not allowed`);
      else valid.push(f);
    }

    if (valid.length === 0) {
      setError(`Nothing uploaded. Use PDF, image, Word, or Excel under ${MAX_UPLOAD_MB} MB. Skipped: ${rejected.join("; ")}.`);
      return;
    }

    setUploading(true);
    setError(null);
    setProgress({ done: 0, total: valid.length });
    const failed: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("submittal_id", submittalId);
        const res = await fetch(`/api/commercial/opportunities/${opportunityId}/attachments`, {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const detail = (body as { detail?: string; error?: string }).detail ?? (body as { error?: string }).error ?? `HTTP ${res.status}`;
          failed.push(`${file.name} — ${detail}`);
        }
      } catch (err) {
        failed.push(`${file.name} — ${err instanceof Error ? err.message : String(err)}`);
      }
      setProgress({ done: i + 1, total: valid.length });
    }
    setUploading(false);
    setProgress(null);

    // Surface a summary only when something was skipped; a clean batch stays quiet.
    const problems = [...rejected, ...failed];
    if (problems.length > 0) {
      const okCount = valid.length - failed.length;
      setError(`${okCount > 0 ? `${okCount} uploaded. ` : ""}Skipped ${problems.length}: ${problems.join("; ")}.`);
    }
    // Refresh once so every successful upload shows up in the linked list.
    router.refresh();
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        multiple
        aria-label="Attach one or more spec sheets"
        accept={ACCEPTED_MIME.join(",")}
        onChange={onFileChange}
        className="hidden"
        aria-hidden
      />
      <button
        type="button"
        onClick={onPickClick}
        disabled={disabled || uploading}
        title={disabled ? disabledReason : "Upload one or more files (PDF, image, Word, or Excel) directly to this submittal — pick several at once"}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
      >
        {uploading ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
            </svg>
            {progress && progress.total > 1 ? `Uploading ${progress.done}/${progress.total}…` : "Uploading…"}
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
            </svg>
            Upload files
          </>
        )}
      </button>
      {error && (
        <p className="text-[11px] text-rose-700 leading-snug" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
