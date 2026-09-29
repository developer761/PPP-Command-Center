"use client";

import { useId, useState } from "react";
import {
  INTERIOR_FINISHES,
  EXTERIOR_FINISHES,
  SHEEN_MAX,
  type FinishGuideRow,
} from "@/lib/customer-form/finish-guide";

/**
 * "Recommended finishes by area or surface" — the collapsible reference
 * section under "Need help picking colors?".
 *
 * Kate, 2026-09-29: this REPLACES the line that appeared under a bathroom's
 * finish dropdown ("PPP recommends Satin in a bathroom…"). One table the
 * customer can read once beats a nudge repeated on every surface of every
 * room, and it covers finishes the form never had an opinion about — Pearl,
 * Gloss, stucco.
 *
 * Open by default for a CUSTOMER, who has probably never chosen a sheen and is
 * exactly who it is for; the arrow is there for everyone else ("with a
 * collapse arrow if the customer wants to collapse it").
 *
 * Collapsed, but present, on Internal Entry. Kate kept the palette links off
 * that screen in round 2 — an AM does not need somewhere to browse colors —
 * and this is the one piece of that panel that is different: the AM filling
 * the form in is usually on the phone with the customer, and "what is the
 * difference between eggshell and satin" is the question they get asked. It
 * costs them one closed row and answers it.
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

      <div id={panelId} hidden={!open} className="px-5 sm:px-6 pb-5 sm:pb-6">
        <p className="text-xs sm:text-sm text-ppp-charcoal-600 leading-relaxed">
          Color gets most of the attention — but the finish decides how that color reads on your
          wall. Every finish sits on one scale: how much light it reflects.
        </p>

        <FinishTable
          title="Interior"
          caption="Ordered from least light reflected to most"
          rows={INTERIOR_FINISHES}
        />
        <FinishTable
          title="Exterior"
          caption="Two of these names you won't see indoors"
          rows={EXTERIOR_FINISHES}
        />
      </div>
    </section>
  );
}

function FinishTable({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: readonly FinishGuideRow[];
}) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap border-b border-ppp-charcoal-100 pb-1.5">
        <h4 className="font-condensed text-base font-bold text-ppp-navy">{title}</h4>
        <span className="text-[10px] sm:text-[11px] text-ppp-charcoal-500">{caption}</span>
      </div>

      <ul className="divide-y divide-ppp-charcoal-100">
        {rows.map((r) => (
          <li
            key={`${title}-${r.finish}`}
            // Stacks on a phone and lines up in columns from `sm` — a real
            // <table> cannot reflow, and this is read on a phone more often
            // than not.
            className="py-3 sm:grid sm:grid-cols-[5.5rem_7rem_1fr] sm:gap-4 sm:items-baseline"
          >
            <span className="flex items-center gap-2 sm:block">
              <SheenBar level={r.sheen} finish={r.finish} />
            </span>
            <span className="block font-semibold text-ppp-charcoal text-sm mt-1.5 sm:mt-0">
              {r.finish}
            </span>
            <span className="block text-xs sm:text-sm text-ppp-charcoal-600 leading-relaxed mt-0.5 sm:mt-0">
              {r.looksLike && <>{r.looksLike} </>}
              {r.place && <strong className="font-semibold text-ppp-charcoal">{r.place} </strong>}
              {r.where}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How much light this finish throws back, as a bar. Decorative — the finish
 *  name and the words beside it carry the meaning, so it is hidden from
 *  screen readers rather than read out as a number nobody asked for. */
function SheenBar({ level, finish }: { level: number; finish: string }) {
  const pct = Math.round((level / SHEEN_MAX) * 100);
  return (
    <span
      className="inline-block w-[5rem] h-1.5 rounded-full bg-ppp-charcoal-100 overflow-hidden align-middle"
      aria-hidden
      title={`${finish} — sheen ${level} of ${SHEEN_MAX}`}
    >
      <span className="block h-full rounded-full bg-ppp-blue" style={{ width: `${pct}%` }} />
    </span>
  );
}
