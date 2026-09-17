import Link from "next/link";

import { visibleWorklist, type WorkItem } from "@/lib/commercial/worklist";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";

/**
 * The worklist, on screen.
 *
 * Rows, not cards. A card grid makes every item look equally important and fits
 * four of them; the point of this list is that the top row matters more than
 * the fifth, and that you can see ten without scrolling past a wall of chrome.
 *
 * Each row is a link to the place the work happens, so the whole row is the tap
 * target — on a phone, which is where Alex reads this, a small "Open" link on
 * the right is a miss waiting to happen.
 */

const TONE_DOT: Record<WorkItem["tone"], string> = {
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  navy: "bg-ppp-charcoal-400",
  emerald: "bg-emerald-500",
};

const GROUP_LABEL: Record<WorkItem["group"], string> = {
  money: "Money",
  bids: "Bids",
  delivery: "Delivery",
};

const GROUP_CLS: Record<WorkItem["group"], string> = {
  money: "bg-cc-brand-50 text-cc-brand-900 border-cc-brand-300",
  bids: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200",
  delivery: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200",
};

export function Worklist({
  items,
  shown,
  atRiskCents,
}: {
  items: WorkItem[];
  /** How many to render. The rest are counted, not listed. */
  shown: number;
  atRiskCents: number;
}) {
  const top = visibleWorklist(items, shown);
  const more = items.length - top.length;

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          What needs doing
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-cc-brand-600 text-white text-[10px] font-bold tabular-nums">
            {items.length}
          </span>
        </h2>
        {atRiskCents > 0 && (
          <p className="text-[12px] text-ppp-charcoal-500">
            <strong className="text-ppp-charcoal font-bold tabular-nums">{formatCentsCompact(atRiskCents)}</strong>{" "}
            sitting in the money rows
          </p>
        )}
      </div>

      <ul className="rounded-xl border border-ppp-charcoal-100 bg-surface divide-y divide-ppp-charcoal-100 overflow-hidden">
        {top.map((it) => (
          <li key={it.key}>
            <Link
              href={it.href}
              className="flex items-start gap-3 px-3 py-2.5 min-h-[44px] hover:bg-cc-brand-50/40 transition-colors"
            >
              <span aria-hidden className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[it.tone]}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-bold text-ppp-charcoal leading-snug">{it.action}</span>
                  <span
                    className={`inline-flex items-center rounded border px-1.5 text-[9.5px] font-bold uppercase tracking-wide ${GROUP_CLS[it.group]}`}
                  >
                    {GROUP_LABEL[it.group]}
                  </span>
                </span>
                <span className="block text-[12px] text-ppp-charcoal-600 truncate">{it.subject}</span>
                <span className="block text-[11.5px] text-ppp-charcoal-400 leading-snug">{it.why}</span>
              </span>
              {it.cents !== undefined && it.cents > 0 && (
                <span className="shrink-0 text-[13px] font-bold text-ppp-charcoal tabular-nums mt-[1px]">
                  {formatCentsCompact(it.cents)}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>

      {more > 0 && (
        // Named destinations rather than a generic "show all": the rest of the
        // list lives on the surfaces that work it, and sending somebody to a
        // longer copy of this list would just move the problem down a screen.
        <p className="mt-2 text-[12px] text-ppp-charcoal-500">
          and {more} more —{" "}
          <Link href="/commercial/accounting?view=receivables" className="font-semibold text-cc-brand-700 hover:underline">
            the money
          </Link>{" "}
          ·{" "}
          <Link href="/commercial/opportunities" className="font-semibold text-cc-brand-700 hover:underline">
            the bids
          </Link>
        </p>
      )}
    </section>
  );
}

/** Shown in place of the list when there is genuinely nothing to do. */
export function WorklistClear() {
  return (
    <section>
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-2.5">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="text-emerald-700 mt-0.5 shrink-0"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <div>
          <div className="text-[13px] font-bold text-emerald-900">Nothing needs chasing</div>
          <div className="text-[12px] text-emerald-800 leading-snug">
            No late invoices, no overdue bids, nothing unbilled. The figures below are the whole picture.
          </div>
        </div>
      </div>
    </section>
  );
}
