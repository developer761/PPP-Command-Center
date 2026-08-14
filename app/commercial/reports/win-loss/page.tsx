import { redirect } from "next/navigation";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  currentQuarterRange,
  previousQuarterRange,
  currentYearRange,
  previousYearRange,
  getWinLossSummary,
  getCompetitorBreakdown,
  getDecidingFactorBreakdown,
  getLessonsLearnedFeed,
  getWinsAwaitingDebrief,
  etMidnightToUTC,
} from "@/lib/commercial/win-loss/reports";
import { opportunityLossReasonLabel } from "@/lib/commercial/opportunities/db";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { DateField } from "@/components/commercial/date-field";
import { KpiTile } from "@/components/commercial/kpi-tile";
import { GaugeRing, DonutChart } from "@/components/commercial/charts";
import { SubmitButton } from "@/components/commercial/submit-button";

type Preset = "this_quarter" | "last_quarter" | "this_year" | "last_year";
const PRESETS: ReadonlyArray<{ key: Preset; label: string }> = [
  { key: "this_quarter", label: "This Quarter" },
  { key: "last_quarter", label: "Last Quarter" },
  { key: "this_year", label: "This Year" },
  { key: "last_year", label: "Last Year" },
];

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

type SP = Promise<{ from?: string; to?: string; preset?: string }>;

// Use the shared compact formatter so money reads identically across every
// surface ($10,400 → "$10.4k", not a local "$10k"). Karan 2026-07-24.
const formatCents = formatCentsCompact;

/** Split bare "YYYY-MM-DD" into calendar parts for etMidnightToUTC.
 *  Returns null on any non-YYYY-MM-DD input to short-circuit invalid
 *  custom ranges. */
function parseYmdParts(ymd: string): { year: number; monthIdx: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  if (year < 1970 || year > 2100 || monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  return { year, monthIdx, day };
}

/** Format a Date in America/New_York, "Jul 1, 2026" style. */
function fmtEtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function parseRange(sp: { from?: string; to?: string; preset?: string }): {
  fromIso: string;
  toIso: string;
  label: string;
  /** What kind of range the user is viewing — drives chip highlight state. */
  activeKey: Preset | "custom";
  /** Echoed back into the custom-range form's date inputs so the picker
   *  remembers what was last submitted (or shows today as a sane default). */
  fromYmd: string;
  toYmd: string;
  /** True iff the user supplied from/to but we couldn't accept it. The page
   *  renders an inline hint so the fallback isn't invisible. */
  rejected: boolean;
} {
  // Custom range always wins if both dates are present + valid.
  if (sp.from && sp.to) {
    // Parse bare YYYY-MM-DD → { year, monthIdx, day } for etMidnightToUTC.
    // Round 3 recheck audit 2026-07-01: an earlier attempt used
    // `new Date(ymd + "T12:00:00Z")` which is 8am ET, silently excluding
    // debriefs stamped between midnight and 8am ET on `sp.from` AND
    // debriefs from 8am ET onward on `sp.to`. The presets (currentQuarter,
    // etc.) already use etMidnightToUTC — the custom range must too.
    const fromParts = parseYmdParts(sp.from);
    const toParts = parseYmdParts(sp.to);
    if (fromParts && toParts) {
      const fromIso = etMidnightToUTC(fromParts.year, fromParts.monthIdx, fromParts.day).toISOString();
      // Push toIso forward one day so the last day is INCLUSIVE (matches
      // the .lt() DB filter — without this, picking "to=Jun 30" silently
      // drops every Jun 30 debrief).
      const toMidnight = etMidnightToUTC(toParts.year, toParts.monthIdx, toParts.day + 1);
      const toIso = toMidnight.toISOString();
      if (new Date(fromIso).getTime() <= new Date(toIso).getTime()) {
        return {
          fromIso,
          toIso,
          label: `${fmtEtDate(new Date(fromIso))} – ${fmtEtDate(new Date(toMidnight.getTime() - 86_400_000))}`,
          activeKey: "custom",
          fromYmd: sp.from,
          toYmd: sp.to,
          rejected: false,
        };
      }
    }
  }
  const supplied = !!(sp.from || sp.to);
  // Otherwise pick a preset (default: this quarter).
  const preset = (sp.preset as Preset) ?? "this_quarter";
  let r: ReturnType<typeof currentQuarterRange>;
  let key: Preset;
  switch (preset) {
    case "last_quarter": r = previousQuarterRange(); key = "last_quarter"; break;
    case "this_year": r = currentYearRange(); key = "this_year"; break;
    case "last_year": r = previousYearRange(); key = "last_year"; break;
    case "this_quarter":
    default: r = currentQuarterRange(); key = "this_quarter"; break;
  }
  // For the custom-form defaults, pre-fill with the active preset's bounds.
  return {
    fromIso: r.fromIso,
    toIso: r.toIso,
    label: r.label,
    activeKey: key,
    fromYmd: r.fromIso.slice(0, 10),
    toYmd: new Date(new Date(r.toIso).getTime() - 86_400_000).toISOString().slice(0, 10),
    rejected: supplied,
  };
}

export default async function WinLossReportsPage({ searchParams }: { searchParams: SP }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const sp = await searchParams;
  const range = parseRange(sp);

  // Immediately-preceding window of EQUAL length, so every range (preset or
  // custom) gets an apples-to-apples "vs prior period" comparison.
  const fromMs = new Date(range.fromIso).getTime();
  const toMs = new Date(range.toIso).getTime();
  const durationMs = Math.max(0, toMs - fromMs);
  const prevRange = { fromIso: new Date(fromMs - durationMs).toISOString(), toIso: range.fromIso };

  const [summary, prevSummary, competitors, factors, lessons, awaitingDebrief] = await Promise.all([
    getWinLossSummary(range),
    getWinLossSummary(prevRange),
    getCompetitorBreakdown(range, 10),
    getDecidingFactorBreakdown(range),
    getLessonsLearnedFeed(range, 20),
    // The actual work-list behind the dashboard's "Awaiting debrief" card, which
    // links here (audit N19). Whole-book, not range-scoped — an un-debriefed win
    // needs filing regardless of which period is on screen.
    getWinsAwaitingDebrief(50),
  ]);

  // Win-rate delta vs prior period (only meaningful when both periods had
  // head-to-heads). Points, not %-of-%, so "45% → 52%" reads as "+7".
  const hadHeadToHead = summary.wonCount + summary.lostCount > 0;
  const prevHadHeadToHead = prevSummary.wonCount + prevSummary.lostCount > 0;
  const winRateDelta = hadHeadToHead && prevHadHeadToHead ? summary.winRatePct - prevSummary.winRatePct : null;

  const totalCompetitorMentions = competitors.reduce((sum, c) => sum + c.total_count, 0);
  const totalFactorMentions = factors.reduce((sum, f) => sum + f.count, 0);

  return (
    // Match the shared Reports framework width/inset so the tab bar aligns with
    // the body, and use the sibling tabs' compact header (audit R3 #8 / #23).
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-ppp-charcoal">Win / Loss</h2>
            <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
              {range.label}
            </span>
          </div>
          <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
            What we&apos;re winning and losing, over the period you choose — and, from the debriefs that have been filed, why.
          </p>
        </div>
      </div>

      {/* ─── Toolbar with period picker (preset chips + custom range form) ─── */}
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => {
            const active = range.activeKey === p.key;
            return (
              <Link
                key={p.key}
                href={p.key === "this_quarter"
                  ? "/commercial/reports/win-loss"
                  : `/commercial/reports/win-loss?preset=${p.key}`}
                className={`inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-semibold border min-h-[44px] touch-manipulation transition-colors ${
                  active
                    ? "bg-cc-brand-600 text-white border-cc-brand-700 shadow-sm shadow-cc-brand-600/30"
                    : "bg-surface text-ppp-charcoal-700 border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
                }`}
                aria-current={active ? "page" : undefined}
              >
                {p.label}
              </Link>
            );
          })}
          <span className="text-[11px] text-ppp-charcoal-400 mx-1 hidden sm:inline" aria-hidden>
            or custom range:
          </span>
          <form
            action="/commercial/reports/win-loss"
            method="GET"
            className="inline-flex flex-wrap items-center gap-2"
          >
            <div className="w-[168px]">
              <DateField
                id="rng_from"
                name="from"
                defaultValue={range.fromYmd}
                placeholder="From date"
                ariaLabel="From date"
              />
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ppp-charcoal-400 shrink-0"><path d="M5 12h14 M13 5l7 7-7 7" /></svg>
            <div className="w-[168px]">
              <DateField
                id="rng_to"
                name="to"
                defaultValue={range.toYmd}
                placeholder="To date"
                ariaLabel="To date"
              />
            </div>
            <SubmitButton
              className={`inline-flex items-center px-3.5 py-2 rounded-lg text-[13px] font-semibold border min-h-[44px] touch-manipulation transition-colors ${
                range.activeKey === "custom"
                  ? "bg-cc-brand-600 text-white border-cc-brand-700 shadow-sm shadow-cc-brand-600/30"
                  : "bg-surface text-ppp-charcoal-700 border-ppp-charcoal-200 hover:border-ppp-charcoal-300 hover:bg-ppp-charcoal-50"
              }`}
            >
              Apply
            </SubmitButton>
          </form>
        </div>
        {range.rejected && (
          <p className="text-[11px] text-rose-700">
            Custom range was invalid — showing <span className="font-semibold">{range.label}</span> instead.
          </p>
        )}
      </div>

      {/* Wins awaiting a debrief — the actionable list behind the dashboard's
          "Awaiting debrief" card, which links here (audit N19). Whole-book, so
          it can be worked to empty regardless of the period on screen. */}
      {awaitingDebrief.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
          <header className="px-4 py-2.5 border-b border-amber-200 flex items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-bold text-amber-900">
              {awaitingDebrief.length} win{awaitingDebrief.length === 1 ? "" : "s"} awaiting a debrief
            </h2>
            <span className="text-[11px] text-amber-700">A quick debrief is what makes this report useful.</span>
          </header>
          <ul className="divide-y divide-amber-200/70">
            {awaitingDebrief.slice(0, 8).map((d) => (
              <li key={d.id}>
                <Link
                  href={`/commercial/accounts/${d.account_id}/debrief/${d.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-amber-100/60 min-h-[44px]"
                >
                  <span className="min-w-0 truncate text-[13px] font-semibold text-amber-900">{d.label}</span>
                  <span className="shrink-0 text-[12px] font-semibold text-amber-800 inline-flex items-center gap-0.5">
                    Debrief
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {awaitingDebrief.length > 8 && (
            <p className="px-4 py-2 text-[11px] text-amber-700 border-t border-amber-200">
              +{awaitingDebrief.length - 8} more — open each deal to file its debrief.
            </p>
          )}
        </section>
      )}

      {/* KPI strip. Karan 2026-07-09 polish: added a "$ won ratio" tile
          because count-based win rate hides big-vs-small deal dynamics
          — winning one $500k job while losing three $50k jobs is a
          different story than the reverse, and only the $ split shows
          it. Win rate reads "—" instead of "0%" when there were no
          head-to-heads (only no-bids), so an empty period doesn't look
          like a wipeout. */}
      <div className="flex items-center gap-1.5 text-[11px] text-ppp-charcoal-500">
        <span>How these are measured</span>
        <span
          tabIndex={0}
          role="img"
          aria-label="Counts every deal DECIDED in this period, by its decision date — a win counts whether or not a debrief has been filed. The competitor and deciding-factor breakdowns below still come from debriefs, because that is where the reasons are recorded."
          title="Counts every deal DECIDED in this period, by its decision date — a win counts whether or not a debrief has been filed. The competitor and deciding-factor breakdowns below still come from debriefs, because that is where the reasons are recorded."
          className="inline-flex items-center justify-center h-4 w-4 rounded-full border border-ppp-charcoal-300 text-ppp-charcoal-500 text-[9px] font-bold cursor-help focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30"
        >
          ?
        </span>
      </div>
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiTile
          tone="emerald"
          label="Win rate"
          value={hadHeadToHead ? `${summary.winRatePct}%` : "—"}
          sub={
            hadHeadToHead
              ? winRateDelta !== null && winRateDelta !== 0
                ? `${summary.wonCount}W · ${summary.lostCount}L · ${winRateDelta > 0 ? "▲" : "▼"}${Math.abs(winRateDelta)}pt vs prior`
                : `${summary.wonCount} won · ${summary.lostCount} lost`
              : "no head-to-heads yet"
          }
        />
        <KpiTile
          tone="navy"
          label="$ won ratio"
          value={(() => {
            const totalValue = summary.wonValueCents + summary.lostValueCents;
            if (totalValue === 0) return "—";
            return `${Math.round((summary.wonValueCents / totalValue) * 100)}%`;
          })()}
          sub="of every $ we bid on"
        />
        <KpiTile
          tone="emerald"
          label="Won $"
          value={formatCents(summary.wonValueCents)}
          sub={summary.wonCount === 1 ? "1 opportunity" : `${summary.wonCount} opportunities`}
        />
        <KpiTile
          tone="rose"
          label="Lost $"
          value={formatCents(summary.lostValueCents)}
          sub={summary.lostCount === 1 ? "1 opportunity" : `${summary.lostCount} opportunities`}
        />
        <KpiTile
          tone="neutral"
          label="No-bid"
          value={String(summary.noBidCount)}
          sub={summary.noBidCount === 1 ? "opportunity we passed on" : "opportunities we passed on"}
        />
      </section>

      {summary.totalClosed === 0 ? (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center">
          <h2 className="text-base font-semibold text-ppp-charcoal mb-2">
            No deals decided in this period
          </h2>
          <p className="text-sm text-ppp-charcoal-500">
            Try a wider range, or head to the{" "}
            <Link href="/commercial/opportunities" className="text-cc-brand-700 underline">pipeline</Link> to close some deals.
          </p>
        </section>
      ) : (
        <>
          {/* Win-rate gauge + won-vs-lost $ donut */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            <article className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 flex items-center gap-5">
              {summary.wonCount + summary.lostCount > 0 ? (
                <GaugeRing pct={summary.winRatePct} tone="emerald" value={`${summary.winRatePct}%`} label="win rate" size={120} />
              ) : (
                <div className="shrink-0 flex flex-col items-center justify-center h-[120px] w-[120px] rounded-full border-[9px] border-ppp-charcoal-100">
                  <div className="font-condensed text-2xl font-black text-ppp-charcoal-300">—</div>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400 mt-1">win rate</div>
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-ppp-charcoal">Win rate</div>
                <div className="text-[12px] text-ppp-charcoal-500 mt-0.5">
                  <strong className="text-emerald-700 tabular-nums">{summary.wonCount}</strong> won
                  <span className="text-ppp-charcoal-300"> · </span>
                  <strong className="text-rose-700 tabular-nums">{summary.lostCount}</strong> lost
                  {summary.noBidCount > 0 && <span className="text-ppp-charcoal-400"> · {summary.noBidCount} no-bid</span>}
                </div>
                {summary.wonValueCents + summary.lostValueCents > 0 && (
                  <div className="text-[11px] text-ppp-charcoal-400 mt-1">
                    {Math.round((summary.wonValueCents / (summary.wonValueCents + summary.lostValueCents)) * 100)}% of bid dollars won
                  </div>
                )}
              </div>
            </article>
            <article className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
              <h2 className="text-[13px] font-bold text-ppp-charcoal mb-3">Won vs lost value</h2>
              <DonutChart
                size={150}
                segments={[
                  { label: "Won $", value: summary.wonValueCents, tone: "emerald", valueLabel: formatCents(summary.wonValueCents) },
                  { label: "Lost $", value: summary.lostValueCents, tone: "rose", valueLabel: formatCents(summary.lostValueCents) },
                ]}
                centerValue={formatCents(summary.wonValueCents + summary.lostValueCents)}
                centerLabel="bid $"
              />
            </article>
          </section>

          {/* Competitor leaderboard + Deciding factor — side-by-side on desktop, stacked on mobile */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            <article className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
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

            <article className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5">
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
                            <div className="h-full bg-rose-400" style={{ width: `${pct}%` }} aria-hidden />
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
          <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-ppp-charcoal mb-3">
              What we&apos;d do differently — recent
            </h2>
            {lessons.length === 0 ? (
              <p className="text-sm text-ppp-charcoal-500">
                No lessons captured yet in this period.
              </p>
            ) : (
              <ul className="space-y-3 divide-y divide-ppp-charcoal-50">
                {lessons.map((l) => (
                  <li key={l.debrief_id} className="pt-3 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-2 mb-1">
                      <Link
                        href={`/commercial/opportunities/${l.opportunity_id}`}
                        className="text-sm font-semibold text-cc-brand-700 hover:text-cc-brand-800 underline underline-offset-2"
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
                      {fmtEtDate(new Date(l.debriefed_at))}
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
