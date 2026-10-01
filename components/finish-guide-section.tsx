"use client";

import { useId, useState } from "react";
import {
  FINISH_GUIDE_INTRO,
  INTERIOR_FINISHES,
  INTERIOR_CAPTION,
  EXTERIOR_FINISHES,
  EXTERIOR_CAPTION,
  type FinishGuideRow,
} from "@/lib/customer-form/finish-guide";

/**
 * "Recommended finishes by area or surface" — the collapsible reference
 * section under "Need help picking colors?".
 *
 * Kate, 2026-09-29: this REPLACES the line that appeared under a bathroom's
 * finish dropdown ("PPP recommends Satin in a bathroom…"). One table the
 * customer reads once beats a nudge repeated on every surface of every room.
 *
 * Her revised layout: one explanatory line, then Interior and Exterior blocks.
 * No column headings — her table has none, and "Finish / Where / What it's
 * like" over three short columns is scaffolding the rows do not need.
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
 *
 * `showInterior` / `showExterior` scope it to the job (Kate, 2026-10-01: "hide
 * interior finish options for exterior-only projects and vice-versa"). Both
 * default to true, and a job with no signal either way shows both — the same
 * fallback filterMaterialTypesForWorkOrder already takes, because guessing
 * wrong here hides the half of the table the customer needed.
 */
export default function FinishGuideSection({
  defaultOpen = true,
  showInterior = true,
  showExterior = true,
}: {
  defaultOpen?: boolean;
  showInterior?: boolean;
  showExterior?: boolean;
}) {
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
        <p className="text-xs sm:text-sm text-ppp-charcoal-600 leading-relaxed">{FINISH_GUIDE_INTRO}</p>
        {showInterior && (
          <FinishBlock title="Interior" caption={INTERIOR_CAPTION} rows={INTERIOR_FINISHES} />
        )}
        {showExterior && (
          <FinishBlock title="Exterior" caption={EXTERIOR_CAPTION} rows={EXTERIOR_FINISHES} />
        )}
      </div>
    </section>
  );
}

function FinishBlock({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: readonly FinishGuideRow[];
}) {
  return (
    <div className="mt-4">
      {/* "Recommended Surface" sits ON the heading line, above the rule — Kate
          moved it there on 2026-10-01 ("move the header above the line"); it
          had been dropped into the gap between the rule and the first row,
          which read as a stray caption belonging to Flat rather than a column
          heading.

          One row, two layouts: flex below `sm` (title left, caption right,
          column heading hidden because the rows are stacked and there are no
          columns for it to label) and the rows' own 3-column grid from `sm` up,
          so the heading lands exactly over the column it names. */}
      <div className="border-b border-ppp-charcoal-100 pb-1.5 flex items-baseline justify-between gap-3 flex-wrap sm:grid sm:grid-cols-[6.5rem_12rem_1fr] sm:gap-4 sm:justify-normal">
        <h4 className="font-condensed text-sm sm:text-base font-bold text-ppp-navy">{title}</h4>
        <span className="hidden sm:block text-[10px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
          Recommended Surface
        </span>
        <span className="text-[10px] sm:text-[11px] text-ppp-charcoal-500 sm:text-right">
          {caption}
        </span>
      </div>

      <ul className="divide-y divide-ppp-charcoal-100">
        {rows.map((r) => (
          <li
            key={`${title}-${r.finish}`}
            // Stacks on a phone, three columns from `sm`. A real <table> cannot
            // reflow, and this is read on a phone more often than not.
            className="py-2 sm:grid sm:grid-cols-[6.5rem_12rem_1fr] sm:gap-4 sm:items-baseline"
          >
            <span className="block font-semibold text-ppp-charcoal text-sm">{r.finish}</span>
            <span className="block text-xs sm:text-sm text-ppp-charcoal-600">{r.where}</span>
            <span className="block text-xs sm:text-sm text-ppp-charcoal-500 leading-relaxed">
              {r.description}
            </span>
            {/* Katie's mockup, 2026-10-01: the product recommendation is a
                highlighted box ACROSS the whole row, not a third line inside
                the description column. sm:col-span-3 is what spans it; on a
                phone the row is already stacked, so it simply sits last.
                Amber on amber-50 rather than the brand orange, which fails AA
                against this background. */}
            {r.product && (
              <span className="block sm:col-span-3 mt-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 leading-relaxed">
                {r.product}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
