"use client";

/**
 * The receipt-photo picker, with the phone-photo shrink built in.
 *
 * A phone snap is routinely over Vercel's ~4.5 MB multipart cap, which 413s the
 * whole submit at the edge — typed amount, vendor, job and all — before the
 * server action ever runs, so nothing can even round-trip the values back
 * (audit U1). An oversized image is shrunk under the cap on the client; one
 * that can't be (a big PDF, or a HEIC the browser can't decode) is refused with
 * a clear note and the input cleared, so the cost still saves without it.
 *
 * It used to live inside the Costs tool's purchase form only. The Accounting
 * page's "Record a purchase" form — the one Mary actually uses — had a bare
 * file input, so the same receipt photo that uploaded fine from the job's Costs
 * tool lost her whole entry from Accounting. One component now, used by both.
 *
 * The submit guard is a native listener on the enclosing form rather than an
 * `onSubmit` prop, so the component works inside a form it does not own (the
 * Accounting forms are server-rendered). A tap that lands mid-shrink would post
 * the original oversized photo; preventing the native submit stops React's
 * form action from running, and the note asks for a second tap.
 */

import { useEffect, useRef, useState } from "react";
import { shrinkImageUnder } from "@/lib/commercial/uploads/downscale-image";
import { SAFE_MULTIPART_BYTES, multipartOversizeError } from "@/lib/commercial/uploads/size-limit";

export const RECEIPT_ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif";

export const RECEIPT_INPUT_CLS =
  "block w-full text-base sm:text-[13px] text-ppp-charcoal-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-[13px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:min-h-[44px]";

export function ReceiptFileInput({
  id,
  name = "receipt",
}: {
  id?: string;
  name?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const shrinkingRef = useRef(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const guard = (e: Event) => {
      if (!shrinkingRef.current) return;
      e.preventDefault();
      setNote({ tone: "ok", text: "One moment — still optimizing the photo. Tap Save again." });
    };
    form.addEventListener("submit", guard, { capture: true });
    return () => form.removeEventListener("submit", guard, { capture: true });
  }, []);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const f = input.files?.[0];
    if (!f) { setNote(null); return; }
    if (f.size <= SAFE_MULTIPART_BYTES) { setNote(null); return; }

    setNote({ tone: "ok", text: "Optimizing photo…" });
    shrinkingRef.current = true;
    let shrunk = f;
    try {
      shrunk = await shrinkImageUnder(f, SAFE_MULTIPART_BYTES);
    } finally {
      shrinkingRef.current = false;
    }

    if (shrunk.size > SAFE_MULTIPART_BYTES) {
      // Couldn't get it under the cap (non-image, or undecodable HEIC).
      setNote({ tone: "err", text: multipartOversizeError(f, "here") ?? "That file is too large." });
      input.value = "";
      return;
    }
    if (shrunk !== f) {
      const dt = new DataTransfer();
      dt.items.add(shrunk);
      input.files = dt.files;
      setNote({ tone: "ok", text: `Photo optimized to ${(shrunk.size / 1024 / 1024).toFixed(1)} MB so it uploads reliably.` });
    } else {
      setNote(null);
    }
  };

  return (
    <>
      {/* capture="environment" opens the camera straight away on a phone so a
          field crew member can snap the receipt in one tap (2026-08 field
          walk). HEIC/HEIF accepted so iPhone photos aren't greyed out. */}
      <input
        ref={ref}
        onChange={onChange}
        id={id}
        name={name}
        type="file"
        accept={RECEIPT_ACCEPT}
        capture="environment"
        className={RECEIPT_INPUT_CLS}
      />
      {note && (
        <p
          className={`text-[11px] mt-1 ${note.tone === "err" ? "text-rose-700" : "text-ppp-charcoal-500"}`}
          role={note.tone === "err" ? "alert" : "status"}
        >
          {note.text}
        </p>
      )}
    </>
  );
}
