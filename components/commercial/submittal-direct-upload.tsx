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
  const [error, setError] = useState<string | null>(null);

  const onPickClick = () => {
    setError(null);
    inputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so picking the same file twice still triggers change.
    e.target.value = "";

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`File is too big. Max ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    if (file.type && !ACCEPTED_MIME.includes(file.type)) {
      setError(`File type "${file.type}" isn't allowed. Use PDF, image, Word, or Excel.`);
      return;
    }

    setUploading(true);
    setError(null);
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
        setError(`Upload failed: ${detail}`);
        return;
      }
      // Success — refresh the server component so the new attachment
      // shows up in the linked list. router.refresh() re-fetches server
      // components without a full page navigation.
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Upload failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MIME.join(",")}
        onChange={onFileChange}
        className="hidden"
        aria-hidden
      />
      <button
        type="button"
        onClick={onPickClick}
        disabled={disabled || uploading}
        title={disabled ? disabledReason : "Upload a PDF (or image / Word / Excel) directly to this submittal"}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
      >
        {uploading ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin" aria-hidden>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
            </svg>
            Uploading…
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
            </svg>
            Upload PDF
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
