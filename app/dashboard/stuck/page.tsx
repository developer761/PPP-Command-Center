import Link from "next/link";
import { loadDashboardData } from "@/lib/data-source";
import { deriveStuckDeals } from "@/lib/salesforce/derive";
import PageHeader from "@/components/page-header";
import { fmtMoneyK } from "@/lib/format";

/**
 * Stuck deals — focused list view of every open Opportunity that hasn't
 * moved in 14+ days. Surfaces:
 *   - Customer name + amount at risk
 *   - Days since last activity (color-coded: orange 14-30, red >30)
 *   - Owner (so admin can ping the right rep)
 *   - Current stage
 *
 * Scope: the loaded bundle already applies viewer scoping, so workers
 * see only THEIR stuck deals, admins see everything company-wide.
 *
 * Per Alex-UX audit: replaces the previous "Review reps with stuck deals"
 * → /dashboard/rep redirect (which was a rep leaderboard, not a deal
 * detail). Alex wanted "which 5 deals are stalling" answerable in 5
 * seconds — this page is that.
 */

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StuckDealsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);

  const deals = bundle.snapshot ? deriveStuckDeals(bundle.snapshot, 14) : [];
  const totalAtRisk = deals.reduce((sum, d) => sum + d.amount, 0);
  const uniqueOwners = new Set(deals.map((d) => d.ownerId)).size;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Stuck Deals"
        subtitle="Open opportunities with no activity in 14+ days. Biggest dollar exposure first — chase these before they go cold."
      />

      {/* Headline summary */}
      <section className="grid grid-cols-3 gap-3 sm:gap-4 mb-6">
        <SummaryCard
          label="At risk"
          value={fmtMoneyK(Math.round(totalAtRisk / 1000))}
          tone={totalAtRisk > 50_000 ? "orange" : "navy"}
        />
        <SummaryCard
          label="Stuck deals"
          value={deals.length.toLocaleString()}
          tone={deals.length > 10 ? "orange" : "navy"}
        />
        <SummaryCard
          label="Reps affected"
          value={uniqueOwners.toLocaleString()}
          tone="navy"
        />
      </section>

      {deals.length === 0 ? (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-2xl mb-3">
            ✓
          </div>
          <h3 className="text-base font-bold text-ppp-charcoal">Nothing stuck.</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
            Every open opportunity has had activity in the last 14 days. Nice.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                <tr>
                  <th className="text-left px-5 py-3">Customer</th>
                  <th className="text-left px-5 py-3">Stage</th>
                  <th className="text-left px-5 py-3">Owner</th>
                  <th className="text-right px-5 py-3">At risk</th>
                  <th className="text-right px-5 py-3">Days idle</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id} className="border-t border-ppp-charcoal-100">
                    <td className="px-5 py-3 font-medium text-ppp-charcoal">{d.accountName ?? "(unknown)"}</td>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100">
                        {d.stageName}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ppp-charcoal-500">
                      <Link
                        href={`/dashboard/rep/${d.ownerId}`}
                        className="hover:text-ppp-blue hover:underline"
                      >
                        {d.ownerName}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-right font-semibold text-ppp-charcoal">
                      {d.amount > 0 ? fmtMoneyK(Math.round(d.amount / 1000)) : <span className="text-ppp-charcoal-500 font-normal italic">no $</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <DaysIdle days={d.daysSinceActivity} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked card list */}
          <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
            {deals.map((d) => (
              <li key={d.id} className="px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-ppp-charcoal truncate">{d.accountName ?? "(unknown)"}</div>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/dashboard/rep/${d.ownerId}`}
                        className="hover:text-ppp-blue hover:underline"
                      >
                        {d.ownerName}
                      </Link>
                      <span>·</span>
                      <span>{d.stageName}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold text-ppp-charcoal">
                      {d.amount > 0 ? fmtMoneyK(Math.round(d.amount / 1000)) : <span className="text-ppp-charcoal-500 font-normal italic">no $</span>}
                    </div>
                    <div className="mt-0.5">
                      <DaysIdle days={d.daysSinceActivity} />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = "navy",
}: {
  label: string;
  value: string;
  tone?: "navy" | "orange";
}) {
  const valueClass = tone === "orange" ? "text-ppp-orange-700" : "text-ppp-navy";
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
      <div className="text-[11px] font-condensed uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`mt-1 font-condensed text-2xl sm:text-3xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}

function DaysIdle({ days }: { days: number }) {
  // Color escalation based on staleness — Alex's eye should be drawn to the
  // long-idle deals first. 14-30d = orange (recently stuck), 30+ = red
  // (deeply stuck, customer might have gone cold or already chose a competitor).
  const tone =
    days >= 60 ? "bg-ppp-orange text-white border-ppp-orange"
    : days >= 30 ? "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100"
    : "bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold border ${tone}`}>
      {days}d
    </span>
  );
}
