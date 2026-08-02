"use client";

/**
 * Proposal marked-up / bid-set document uploader (R1c, Karan 2026-08).
 *
 * Estimators often mark up the GC's plan set or a prior bid while pricing.
 * This button attaches that file straight to the parent OPPORTUNITY's
 * Documents under the "bid_set" category in one round-trip — no detour to
 * the deal's Documents tab. It files to the deal (not the proposal) because
 * a marked-up plan is job-scoped and survives every revision bump.
 *
 * Internal-only artifact — never rendered on the customer PDF. Mirrors the
 * server-side MIME + size validation so obvious rejects fail instantly.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

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

export default function ProposalMarkupUpload({
  opportunityId,
  disabled = false,
  disabledReason,
}: {
  opportunityId: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPickClick = () => {
    if (disabled) return;
    setError(null);
    inputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
      fd.append("category", "bid_set");
      fd.append("notes", "Marked-up / bid-set doc attached from the proposal builder.");
      const res = await fetch(`/api/commercial/opportunities/${opportunityId}/documents`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail =
          (body as { detail?: string; error?: string }).detail ??
          (body as { error?: string }).error ??
          `HTTP ${res.status}`;
        setError(`Upload failed: ${detail}`);
        return;
      }
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Upload failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
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
        title={disabled ? disabledReason : "Attach a marked-up plan set or bid document to this deal (internal)"}
        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-cc-brand-300 bg-surface text-cc-brand-700 text-[13px] font-semibold hover:bg-cc-brand-50 min-h-[44px] touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12" />
            </svg>
            Attach marked-up doc
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
