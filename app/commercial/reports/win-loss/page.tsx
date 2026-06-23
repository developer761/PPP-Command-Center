import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  currentQuarterRange,
  getWinLossSummary,
  getCompetitorBreakdown,
  getDecidingFactorBreakdown,
  getLessonsLearnedFeed,
} from "@/lib/commercial/win-loss/reports";
import { opportunityLossReasonLabel } from "@/lib/commercial/opportunities/db";

/**
 * Win/Loss Reports — Alex's quarterly review surface. Aggregates every
 * `commercial_win_loss_debrief` row into:
 *   - top-line KPIs (win rate, total $ won, total $ lost, no-bid count)
 *   - competitor leaderboard (who we lose to most)
 *   - deciding-factor breakdown (why we're losing)
 *   - lessons-learned feed (the "what we'd do differently" column)
 *
 * Date range defaults to current quarter; query param `?from=…&to=…`
 * lets Alex pick any window for the upcoming review.
 *
 * Mobile-first: KPI cards stack on small screens, breakdowns become
 * card lists, the lessons feed is the bottom of the scroll.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ from?: string; to?: string }>;

function formatCents(cents: number): string {
  if (cents === 0) return "$0";
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (Math.abs(dollars) >= 10_000) return `$${Math.round(dollars / 1000)}k`;
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function parseRange(sp: { from?: string; to?: string }): {
  fromIso: string;
  toIso: string;
  label: string;
  isCustom: boolean;
} {
  if (sp.from && sp.to) {
    const fromDate = new Date(sp.from);
    const toDate = new Date(sp.to);
    if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
      return {
        fromIso: fromDate.toISOString(),
        toIso: toDate.toISOString(),
        label: `${fromDate.toLocaleDateString()} – ${toDate.toLocaleDateString()}`,
        isCustom: true,
      };
    }
  }
  const q = currentQuarterRange();
  return { fromIso: q.fromIso, toIso: q.toIso, label: q.label, isCustom: false };
}

export default async function WinLossReportsPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const sp = await searchParams;
  const range = parseRange(sp);

  const [summary, competitors, factors, lessons] = await Promise.all([
    getWinLossSummary(range),
    getCompetitorBreakdown(range, 10),
    getDecidingFactorBreakdown(range),
    getLessonsLearnedFeed(range, 20),
  ]);

  const totalCompetitorMentions = competitors.reduce((sum, c) => sum + c.total_count, 0);
  const totalFactorMentions = factors.reduce((sum, f) => sum + f.count, 0);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 animate-fade-up">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal">
          Win/Loss Reports
        </h1>
        <p className="text-sm text-ppp-charcoal-500 mt-2 leading-relaxed">
          Aggregated debrief data — what we&apos;re winning, what we&apos;re losing, and why.
          Quarterly review fuel. <span className="font-medium text-ppp-charcoal">Period: {range.label}.</span>
        </p>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <KpiCard
          label="Win rate"
          value={`${summary.winRatePct}%`}
          subline={`${summary.wonCount} won / ${summary.lostCount} lost`}
        />
        <KpiCard
          label="Won $"
          value={formatCents(summary.wonValueCents)}
          subline={summary.wonCount === 1 ? "1 deal" : `${summary.wonCount} deals`}
        />
        <KpiCard
          label="Lost $"
          value={formatCents(summary.lostValueCents)}
          subline={summary.lostCount === 1 ? "1 deal" : `${summary.lostCount} deals`}
          accentNegative
        />
        <KpiCard
          label="No-bid"
          value={String(summary.noBidCount)}
          subline="We passed"
        />
      </section>

      {summary.totalClosed === 0 ? (
        <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <h2 className="text-base font-semibold text-ppp-charcoal mb-2">
            No debriefs in this period yet
          </h2>
          <p className="text-sm text-ppp-charcoal-500">
            As opportunities close with completed debriefs, they&apos;ll show up here.
            See <Link href="/commercial/opportunities" className="text-emerald-700 underline">opportunities</Link> for active deals.
          </p>
        </section>
      ) : (
        <>
          {/* Competitor leaderboard + Deciding factor — side-by-side on desktop, stacked on mobile */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            <article className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
                Who we lose to most
              </h2>
              {competitors.length === 0 ? (
                <p className="text-sm text-ppp-charcoal-500">No competitor data yet.</p>
              ) : (
                <ul className="space-y-2">
                  {competitors.map((c) => {
                    const pct = totalCompetitorMentions > 0
                      ? Math.round((c.total_count / totalCompetitorMentions) * 100)
                      : 0;
                    return (
                      <li key={c.competitor_id ?? "unknown"} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-ppp-charcoal truncate">
                              {c.competitor_name}
                            </span>
                            <span className="text-[11px] text-ppp-charcoal-500 shrink-0">
                              {c.lost_count > 0 && (
                                <span className="text-rose-700 font-semibold">{c.lost_count} loss{c.lost_count === 1 ? "" : "es"}</span>
                              )}
                              {c.won_count > 0 && (
                                <span className="ml-2 text-emerald-700 font-semibold">{c.won_count} win{c.won_count === 1 ? "" : "s"}</span>
                              )}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 bg-ppp-charcoal-50 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-rose-500"
                              style={{ width: `${pct}%` }}
                              aria-label={`${pct}% of debriefs mention this competitor`}
                            />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>

            <article className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
                Why we lose
              </h2>
              {factors.length === 0 ? (
                <p className="text-sm text-ppp-charcoal-500">No deciding-factor data yet.</p>
              ) : (
                <ul className="space-y-2">
                  {factors.map((f) => {
                    const pct = totalFactorMentions > 0
                      ? Math.round((f.count / totalFactorMentions) * 100)
                      : 0;
                    const label = f.deciding_factor === "(unspecified)"
                      ? "(unspecified)"
                      : opportunityLossReasonLabel(f.deciding_factor as Parameters<typeof opportunityLossReasonLabel>[0]);
                    return (
                      <li key={f.deciding_factor} className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-ppp-charcoal">
                              {label}
                            </span>
                            <span className="text-[11px] text-ppp-charcoal-500 shrink-0">
                              {f.count} ({pct}%)
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 bg-ppp-charcoal-50 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} aria-hidden />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </section>

          {/* Lessons learned feed */}
          <section className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
              What we&apos;d do differently — recent
            </h2>
            {lessons.length === 0 ? (
              <p className="text-sm text-ppp-charcoal-500">
                No lessons captured yet. Encourage the team to fill out the
                &quot;what would you do differently?&quot; field when closing opps.
              </p>
            ) : (
              <ul className="space-y-3 divide-y divide-ppp-charcoal-50">
                {lessons.map((l) => (
                  <li key={l.debrief_id} className="pt-3 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-2 mb-1">
                      <Link
                        href={`/commercial/opportunities/${l.opportunity_id}`}
                        className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                      >
                        {l.opportunity_title}
                      </Link>
                      <OutcomeChip outcome={l.outcome} />
                      {l.competitor_name && (
                        <span className="text-[12px] text-ppp-charcoal-500">
                          vs. <span className="font-medium text-ppp-charcoal">{l.competitor_name}</span>
                        </span>
                      )}
                      {l.deciding_factor && (
                        <span className="text-[11px] uppercase tracking-wider text-ppp-charcoal-400">
                          {opportunityLossReasonLabel(l.deciding_factor as Parameters<typeof opportunityLossReasonLabel>[0])}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-ppp-charcoal leading-relaxed">
                      &ldquo;{l.lessons_learned}&rdquo;
                    </p>
                    <div className="text-[11px] text-ppp-charcoal-400 mt-1">
                      {new Date(l.debriefed_at).toLocaleDateString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  subline,
  accentNegative,
}: {
  label: string;
  value: string;
  subline?: string;
  accentNegative?: boolean;
}) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-4">
      <div className="text-[10px] uppercase tracking-wider text-ppp-charcoal-500 font-semibold">
        {label}
      </div>
      <div className={`text-xl sm:text-2xl font-bold mt-1 ${accentNegative ? "text-rose-700" : "text-ppp-charcoal"}`}>
        {value}
      </div>
      {subline && (
        <div className="text-[11px] text-ppp-charcoal-500 mt-1 truncate">
          {subline}
        </div>
      )}
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: "won" | "lost" | "no_bid" }) {
  const cfg = {
    won: { bg: "bg-emerald-50", fg: "text-emerald-800", label: "Won" },
    lost: { bg: "bg-rose-50", fg: "text-rose-800", label: "Lost" },
    no_bid: { bg: "bg-ppp-charcoal-50", fg: "text-ppp-charcoal-700", label: "No bid" },
  }[outcome];
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.fg}`}>
      {cfg.label}
    </span>
  );
}
