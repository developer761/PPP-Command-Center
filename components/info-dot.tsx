"use client";

import { useState } from "react";

/** Small ⓘ icon button — hover for desktop tooltip, tap to toggle on mobile.
 *  Auto-dismisses on blur so a stale popover doesn't linger after the user
 *  moves on. Use anywhere a number, label, or chip would benefit from a
 *  plain-English "what this means" explanation.
 *
 *  Originally lived inside materials-view.tsx; moved here so the home
 *  dashboard, Customer History, and other surfaces can reuse the same
 *  consistent UI pattern — matters for owner UX (Alex). */
export default function InfoDot({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onBlur={() => setOpen(false)}
        title={text}
        aria-label={`What this means: ${text}`}
        className="inline-flex items-center justify-center h-4 w-4 rounded-full border border-ppp-charcoal-200 text-[9px] font-bold text-ppp-charcoal-500 hover:bg-ppp-charcoal-50 hover:text-ppp-charcoal transition-colors"
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-5 z-30 w-56 normal-case tracking-normal font-normal text-[11px] leading-snug text-ppp-charcoal bg-white border border-ppp-charcoal-100 rounded-lg shadow-lg p-2.5"
        >
          {text}
        </span>
      )}
    </span>
  );
}
