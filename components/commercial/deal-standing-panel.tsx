import {
  billedPct,
  dealStandingLines,
  money,
  type DealStandingInput,
} from "@/lib/commercial/opportunities/deal-standing";

/**
 * Where a job stands, at a glance — the full-width version.
 *
 * Brendan 2026-08-26, relayed by Karan: "below these we can have like account
 * specific important details like billed 5000/25000 and proposal send, work
 * order hasnr been sent ect very imporant stuff **we should make a tab for as
 * well**."
 *
 * "As well" — he wanted the compact block on the Activity rail AND a tab of its
 * own. The first pass built only the block and argued a tab would duplicate it,
 * which was answering a question he had not asked.
 *
 * Both surfaces read `dealStandingLines`, so the rail and the tab cannot drift
 * into two different answers to "where are we". Only the presentation differs:
 * the rail is a 12px sidebar summary, this has room to breathe and to say what
 * each number means.
 */
export function DealStandingPanel({ standing }: { standing: DealStandingInput }) {
  const lines = dealStandingLines(standing);
  const pct = billedPct(standing);
  const left = standing.contractCents - standing.billedCents;

  if (lines.length === 0 && pct === null) {
    return (
      <p className="text-sm text-ppp-charcoal-500">
        Nothing to report yet — this job has no proposal and no contract.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {pct !== null && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-sm font-bold text-ppp-charcoal">Billed against the contract</h3>
            <p className="text-sm tabular-nums">
              <span className="text-lg font-bold text-ppp-charcoal">{money(standing.billedCents)}</span>
              <span className="text-ppp-charcoal-500"> of {money(standing.contractCents)}</span>
            </p>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="h-2.5 flex-1 rounded-full bg-ppp-charcoal-100 overflow-hidden">
              <span
                className="block h-full rounded-full bg-cc-brand-500"
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </span>
            <span className="text-sm font-semibold tabular-nums text-ppp-charcoal-500 shrink-0 w-12 text-right">
              {pct}%
            </span>
          </div>
          <p className="mt-2 text-xs text-ppp-charcoal-500">
            {left > 0
              ? `${money(left)} still to bill. Contract includes approved change orders.`
              : left < 0
              ? `Billed ${money(-left)} over the contract to date — check the change orders are all approved.`
              : "Fully billed against the contract to date."}
          </p>
        </section>
      )}

      {lines.length > 0 && (
        <section className="rounded-xl border border-ppp-charcoal-100 bg-surface overflow-hidden">
          <h3 className="px-4 sm:px-5 py-3 text-sm font-bold text-ppp-charcoal border-b border-ppp-charcoal-100">
            Where it stands
          </h3>
          <ul className="divide-y divide-ppp-charcoal-100">
            {lines.map((l) => (
              <li
                key={l.label}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 sm:px-5 py-3"
              >
                <span className="text-sm text-ppp-charcoal-500">{l.label}</span>
                <span
                  className={`text-sm font-semibold tabular-nums ${
                    // -700, not -600: the 600-on-tinted pairing misses AA.
                    l.tone === "warn" ? "text-amber-700" : "text-ppp-charcoal"
                  }`}
                >
                  {l.value}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
