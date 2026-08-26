import Link from "next/link";

// One money formatter, not two — the copy here had already drifted from the
// one on the Activity rail, so the same $5,004 read "$5.0k" on one screen.
import { money } from "@/lib/commercial/opportunities/deal-standing";

/**
 * What is actually happening on each live job, under the company totals.
 *
 * Brendan 2026-08-26: "under 'this month' it should say things specific to the
 * deals — like this one is billed 5k out of 25k, or the work order hasn't been
 * sent."
 *
 * Everything above this on the Overview is a company aggregate: net profit,
 * margin, revenue billed this month. Those answer "how are we doing" and none
 * of them answer "what do I need to do", so the page was something you looked
 * at rather than something you worked from. This is the same numbers cut by
 * JOB, with the one outstanding fact per row.
 *
 * Ordered by what is unfinished, not by size — a $2k job with an unsent work
 * order is blocking a crew this morning; a $200k job billed in full is not.
 */

export type JobInFlight = {
  oppId: string;
  name: string;
  accountName: string;
  billedCents: number;
  contractCents: number;
  /** The single most useful thing to say about this job right now. */
  flag: string | null;
};

export function JobsInFlight({ jobs }: { jobs: JobInFlight[] }) {
  if (jobs.length === 0) return null;

  return (
    <div className="mt-3 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-[13px] font-bold text-ppp-charcoal">Jobs in flight</h3>
        <Link
          href="/commercial/opportunities?lane=under_contract"
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1"
        >
          All jobs →
        </Link>
      </div>

      <ul className="divide-y divide-ppp-charcoal-100">
        {jobs.map((j) => {
          // Clamped so an over-billed job shows a full bar rather than
          // overflowing its container — the flag says it is over.
          const pct =
            j.contractCents > 0
              ? Math.min(100, Math.round((j.billedCents / j.contractCents) * 100))
              : null;
          return (
            <li key={j.oppId} className="py-2.5 first:pt-0 last:pb-0">
              <Link
                href={`/commercial/opportunities/${j.oppId}`}
                className="group block -mx-2 px-2 py-1 rounded-lg hover:bg-ppp-charcoal-50"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12.5px] font-semibold text-ppp-charcoal truncate group-hover:text-cc-brand-700">
                    {j.name}
                  </span>
                  <span className="text-[11.5px] tabular-nums text-ppp-charcoal-600 shrink-0">
                    {j.contractCents > 0 ? (
                      <>
                        <span className="font-bold text-ppp-charcoal">{money(j.billedCents)}</span>
                        <span className="text-ppp-charcoal-400"> of {money(j.contractCents)}</span>
                      </>
                    ) : (
                      <span className="text-ppp-charcoal-400">no contract value</span>
                    )}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  {pct !== null && (
                    <span className="h-1.5 flex-1 rounded-full bg-ppp-charcoal-100 overflow-hidden">
                      <span
                        className="block h-full rounded-full bg-cc-brand-500"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  )}
                  {pct !== null && (
                    <span className="text-[10.5px] tabular-nums text-ppp-charcoal-400 shrink-0 w-8 text-right">
                      {pct}%
                    </span>
                  )}
                </div>

                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-[11px] text-ppp-charcoal-400 truncate">{j.accountName}</span>
                  {j.flag && (
                    <span className="text-[11px] font-semibold text-amber-700 shrink-0">
                      {j.flag}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
