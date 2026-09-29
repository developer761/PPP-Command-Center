"use client";

import { useId, useState } from "react";
import { FINISH_QUICK_REFERENCE } from "@/lib/customer-form/finish-guide";

/**
 * "Recommended finishes by area or surface" — the collapsible reference
 * section under "Need help picking colors?".
 *
 * Kate, 2026-09-29: this REPLACES the line that appeared under a bathroom's
 * finish dropdown ("PPP recommends Satin in a bathroom…"). One table the
 * customer can read once beats a nudge repeated on every surface of every
 * room.
 *
 * The table is PPP's Finish Quick Reference, at her word: "I just want it to
 * be simple like this, and it's much more compact." Three columns, seven rows.
 * The first pass carried the long Interior/Exterior version with a sheen bar
 * on every row; this is the one she asked for.
 *
 * Open by default for a CUSTOMER, who has probably never chosen a sheen and is
 * exactly who it is for; the arrow is there for everyone else ("with a
 * collapse arrow if the customer wants to collapse it").
 *
 * Collapsed, but present, on Internal Entry. Kate kept the palette links off
 * that screen in round 2 — an AM does not need somewhere to browse colors —
 * and this is the one piece of that panel that is different: the AM filling
 * the form in is usually on the phone with the customer, and "what is the
 * difference between eggshell and satin" is the question they get asked.
 */
export default function FinishGuideSection({ defaultOpen = true }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <section className="bg-white border border-ppp-charcoal-100 rounded-2xl overflow-hidden">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="w-full flex items-center justify-between gap-3 px-5 sm:px-6 py-4 text-left hover:bg-ppp-charcoal-50/60 transition-colors touch-manipulation"
        >
          <span className="font-condensed text-base sm:text-lg font-bold text-ppp-navy">
            Recommended finishes by area or surface
          </span>
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className={`shrink-0 text-ppp-charcoal-500 transition-transform ${open ? "" : "-rotate-90"}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </h3>

      <div id={panelId} hidden={!open} className="px-5 sm:px-6 pb-5">
        {/* Column headings only where there ARE columns. Each row stacks on a
            phone, and "Finish / Typical Use / General Characteristics" over the
            top of a stack labels nothing. */}
        <div className="hidden sm:grid sm:grid-cols-[6.5rem_12rem_1fr] sm:gap-4 pb-1.5 border-b border-ppp-charcoal-100">
          {["Finish", "Typical Use", "General Characteristics"].map((h) => (
            <span key={h} className="text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
              {h}
            </span>
          ))}
        </div>

        <ul className="divide-y divide-ppp-charcoal-100">
          {FINISH_QUICK_REFERENCE.map((r) => (
            <li
              key={r.finish}
              className="py-2 sm:grid sm:grid-cols-[6.5rem_12rem_1fr] sm:gap-4 sm:items-baseline"
            >
              <span className="block font-semibold text-ppp-charcoal text-sm">{r.finish}</span>
              <span className="block text-xs sm:text-sm text-ppp-charcoal-600">{r.typicalUse}</span>
              <span className="block text-xs sm:text-sm text-ppp-charcoal-500 leading-relaxed">
                {r.characteristics}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
