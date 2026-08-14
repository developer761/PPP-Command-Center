"use client";

/**
 * File input for the New Account form's on-create compliance docs, with a
 * client-side size guard.
 *
 * The New Account form is a multipart server action: the typed fields AND any
 * attached file post together. A file over Vercel's ~4.5 MB serverless body cap
 * 413s at the EDGE — the action never runs, so the whole typed form (name,
 * contacts, team, tags) is lost with no recovery (audit U1, worst case). The
 * account doesn't exist yet, so there's no parent to do a direct-to-Storage
 * upload against; the correct fix is to never let an oversized file be
 * submitted here. Guard on change: an over-limit pick is rejected inline (input
 * cleared) with guidance to create the account first and upload the big file
 * from its Documents tab, which uses direct-to-Storage (up to 50 MB). The typed
 * form survives because the oversized bytes are never sent.
 */

import { useState } from "react";

// ~4 MB, comfortably below Vercel's ~4.5 MB serverless request-body cap.
const SAFE_BYTES = 4 * 1024 * 1024;

export default function ComplianceDocInput({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input
        id={id}
        name={name}
        type="file"
        aria-label="Attach compliance document"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && f.size > SAFE_BYTES) {
            setError(
              `${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB — too large to attach while creating the account (4 MB limit here). Create the account first, then upload this from its Documents tab (up to 50 MB). Your typed details are kept.`
            );
            // Never submit the oversized file — that's what would 413 the whole
            // form. Clearing the input keeps the multipart body small so the
            // typed fields still save.
            e.target.value = "";
          } else {
            setError(null);
          }
        }}
        className="block w-full text-[12px] text-ppp-charcoal-700 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-[12px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:cursor-pointer min-h-[44px] touch-manipulation"
      />
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-rose-700 leading-snug">
          {error}
        </p>
      )}
    </>
  );
}
