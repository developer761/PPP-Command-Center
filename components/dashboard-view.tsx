"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import HorizontalBar from "@/components/horizontal-bar";
import KPICard from "@/components/kpi-card";
import Leaderboard from "@/components/leaderboard";
import PageHeader from "@/components/page-header";
import TrendChart from "@/components/trend-chart";
import EmptyScopeBanner from "@/components/empty-scope-banner";
import {
  getFilteredView,
  getFunnelForPeriod,
  getRegionColorToken,
  getRegionOptionsFor,
  PERIOD_LABELS,
  reps as mockReps,
  topPerformer as mockTopPerformer,
  pipelineAtRisk as mockPipelineAtRisk,
  type Period,
  type RegionFilter,
} from "@/lib/mock-data";
import {
  deriveCompanyTrend,
  derivePeriodDelta,
  derivePipelineAtRisk,
  deriveRepsForPeriod,
  deriveTopPerformer,
  deriveTodaySnapshot,
  deriveMonthForecast,
  deriveTopCustomers,
  deriveQuoteToCashVelocity,
  deriveRepMomentum,
  deriveRealFunnel,
} from "@/lib/salesforce/derive";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  [
    "this-month",
    "last-month",
    "30d",
    "90d",
    "this-year",
    "last-year",
    "12m",
    "lifetime",
  ] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

import { fmtMoneyK } from "@/lib/format";

function sign(n: number) {
  return n > 0 ? `+${n}` : `${n}`;
}

type Props = {
  bundle: LiveDashboardBundle;
};

export default function DashboardView({ bundle }: Props) {
  // Default to "This Month" — PPP's day-to-day mental model is month-by-month
  // ("show me May", "what did we do this month"). Their SF reports default
  // to a similar window. Other periods are opt-in via the dropdown.
  const [period, setPeriod] = useState<Period>("this-month");
  const [region, setRegion] = useState<RegionFilter>("all");
  const [funnelPeriod, setFunnelPeriod] = useState<Period | "page">("page");

  const dataSource = bundle.source;
  const dataSourceReason = bundle.reason;
  const snapshot = bundle.snapshot;
  const viewer = bundle.viewer;

  // When the viewer is scoped to a single rep, any "top X across the team" or
  // "vs team avg" card is comparing the rep to themselves — misleading. Hide
  // those cards rather than render a 1-row leaderboard with the rep's name.
  const repScopedToSelf = viewer?.scope === "my" && !!viewer.effectiveUserId;

  // Reps for the active period — recomputes from snapshot when SF is live.
  const reps = useMemo(() => {
    if (snapshot) return deriveRepsForPeriod(snapshot, period);
    return mockReps;
  }, [snapshot, period]);

  // Region options derived from the actual rep set (live or mock).
  const REGION_OPTIONS = useMemo(() => getRegionOptionsFor(reps), [reps]);

  // Base view computed from reps (handles service-line mix, regional rollup, etc).
  const view = useMemo(
    () => getFilteredView(period, region, reps),
    [period, region, reps]
  );

  // Override the trendline series with live data when available.
  const trendSeries = useMemo(() => {
    if (snapshot) {
      const live = deriveCompanyTrend(snapshot, period);
      return live.series;
    }
    return view.series;
  }, [snapshot, period, view.series]);

  // Override the revenue KPI with live period delta.
  const revenueKpi = useMemo(() => {
    if (snapshot) return derivePeriodDelta(snapshot, period);
    return view.kpis.revenueSold;
  }, [snapshot, period, view.kpis.revenueSold]);

  // Derive live close-rate / avg-ticket / open-quotes from the rep set when on
  // live SF data. Otherwise fall back to the mock view's KPIs.
  const liveKpis = useMemo(() => {
    if (!snapshot) return null;
    const totalRevenue = reps.reduce((s, r) => s + r.revenueSold, 0); // $K
    const totalDealsWon = reps.reduce((s, r) => s + Math.round(r.appointmentsHeld * (r.closeRate / 100)), 0);
    // Recompute close/avg-ticket directly from rep numbers to keep everything
    // self-consistent.
    const totalClosed = reps.reduce((s, r) => s + r.appointmentsHeld, 0);
    const totalWon = reps.reduce((s, r) => s + r.quotesSent, 0); // proxies
    void totalDealsWon;
    void totalWon;
    const closeRate = totalClosed > 0
      ? reps.filter((r) => r.closeRate > 0).reduce((s, r) => s + r.closeRate, 0) /
        Math.max(1, reps.filter((r) => r.closeRate > 0).length)
      : 0;
    const ticketReps = reps.filter((r) => r.avgTicket > 0);
    const avgTicket = ticketReps.length > 0
      ? ticketReps.reduce((s, r) => s + r.avgTicket, 0) / ticketReps.length
      : 0;
    const openPipelineK = reps.reduce((s, r) => s + r.openPipeline, 0);
    return {
      totalRevenue,
      closeRate: +closeRate.toFixed(1),
      avgTicket: +avgTicket.toFixed(1),
      openPipelineK,
    };
  }, [snapshot, reps]);

  // Top performer — fall back to mock ONLY when no snapshot at all.
  // When on live data with zero activity, return null so the UI can render
  // an honest empty state (no fake names).
  const topPerformer = useMemo(() => {
    if (snapshot) return deriveTopPerformer(snapshot, period);
    return mockTopPerformer;
  }, [snapshot, period]);

  // Pipeline at risk (live or mock).
  const pipelineAtRisk = useMemo(() => {
    if (snapshot) return derivePipelineAtRisk(snapshot) ?? mockPipelineAtRisk;
    return mockPipelineAtRisk;
  }, [snapshot]);

  // ─── CEO-impressing live snapshots ───
  // Today, month-end forecast, top customers, quote-to-cash velocity.
  const todaySnap = useMemo(() => snapshot ? deriveTodaySnapshot(snapshot) : null, [snapshot]);
  const forecast = useMemo(() => snapshot ? deriveMonthForecast(snapshot) : null, [snapshot]);
  const topCustomers = useMemo(() => snapshot ? deriveTopCustomers(snapshot, 8) : [], [snapshot]);
  const velocity = useMemo(() => snapshot ? deriveQuoteToCashVelocity(snapshot) : null, [snapshot]);

  // Hot reps this week — top 3 with biggest week-over-week jump.
  const hotReps = useMemo(() => {
    if (!snapshot) return [];
    const momentum = deriveRepMomentum(snapshot);
    const ownerNameLookup = new Map<string, string>();
    for (const r of snapshot.reps) ownerNameLookup.set(r.id, r.name);
    for (const w of snapshot.workOrders) {
      if (w.ownerId && w.ownerName) ownerNameLookup.set(w.ownerId, w.ownerName);
    }
    return Array.from(momentum.entries())
      // Require meaningful revenue (≥ $1K this week) so we don't surface
      // a "$0.001K trending +infinity%" mirage when a tiny deal closes.
      .filter(([, m]) => m.thisWeek >= 1000)
      .map(([ownerId, m]) => ({
        id: ownerId,
        name: ownerNameLookup.get(ownerId) ?? "(unknown)",
        thisWeekK: Math.round(m.thisWeek / 1000),
        deltaPct: m.deltaPct,
      }))
      .sort((a, b) => b.thisWeekK - a.thisWeekK)
      .slice(0, 5);
  }, [snapshot]);

  // Pipeline funnel — prefer real funnel from Quote data when on live snapshot.
  // Falls back to mock-style approximation when running on demo data.
  const funnel = useMemo(() => {
    if (snapshot) {
      const effPeriod = funnelPeriod === "page" ? period : funnelPeriod;
      const real = deriveRealFunnel(snapshot, effPeriod);
      // Conform to existing pipelineFunnel shape: { stage, count, value }[].
      return real.map((s) => ({ stage: s.stage, count: s.count, value: s.value }));
    }
    if (funnelPeriod === "page") return view.pipelineFunnel;
    return getFunnelForPeriod(funnelPeriod, region, reps);
  }, [snapshot, funnelPeriod, period, view.pipelineFunnel, region, reps]);

  const effectiveFunnelPeriod: Period = funnelPeriod === "page" ? period : funnelPeriod;

  const liveAndEmpty =
    !!snapshot &&
    (snapshot.reps?.length ?? 0) === 0 &&
    (snapshot.workOrders?.length ?? 0) === 0 &&
    (snapshot.opportunities?.length ?? 0) === 0;

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-up">
      <EmptyScopeBanner empty={liveAndEmpty} />
      <PageHeader
        title="Company Overview"
        subtitle={`Whole-company analytics · ${
          period === "lifetime" ? "all time" : PERIOD_LABELS[period].toLowerCase()
        } · ${region === "all" ? "all regions" : region}`}
        actions={
          <>
            <FilterDropdown<RegionFilter>
              value={region}
              options={REGION_OPTIONS}
              onChange={setRegion}
              srLabel="Region"
              icon={<IconPin />}
            />
            <FilterDropdown<Period>
              value={period}
              options={PERIOD_OPTIONS}
              onChange={setPeriod}
              srLabel="Period"
              icon={<IconCalendar />}
            />
          </>
        }
      />

      {snapshot?.isSandbox && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Connected to PPP Salesforce SANDBOX.</strong> Numbers reflect ~50 test
          opportunities and ~13 work orders in the sandbox — not the production data
          you see in PPP reports. To pull real revenue/reps, Katie needs to grant
          production OAuth access (or recreate the Connected App in production).
          {snapshot.workOrders.length > 0 && (
            <> Currently showing {snapshot.workOrders.length} work orders.</>
          )}
        </div>
      )}

      {dataSource === "mock" && dataSourceReason && (
        <div
          className={[
            "rounded-lg px-4 py-3 text-xs sm:text-sm",
            dataSourceReason === "sf_not_connected"
              ? "border border-ppp-blue-100 bg-ppp-blue-50/60 text-ppp-blue-700"
              : "border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700",
          ].join(" ")}
        >
          {dataSourceReason === "sf_not_connected" ? (
            <>
              <strong>Demo data.</strong> Connect Salesforce in <strong>Admin → Integrations</strong> to see real PPP data.
            </>
          ) : dataSourceReason === "sf_returned_empty" ? (
            <>
              <strong>Salesforce sandbox has no rep activity yet.</strong> Showing demo data so the dashboard renders. Ask Katie to load test data into the sandbox, or switch to production once that's wired.
            </>
          ) : (
            <>
              <strong>Live data unavailable:</strong> {dataSourceReason}. Falling back to demo data.
            </>
          )}
        </div>
      )}

      {/* ─── Today's snapshot strip + month forecast ─── */}
      {todaySnap && forecast && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
          {/* Today */}
          <div className="bg-gradient-to-br from-ppp-navy to-ppp-charcoal text-white rounded-xl p-5 sm:p-6 shadow-lg shadow-ppp-charcoal/10">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold opacity-70">Today</div>
                <div className="font-condensed text-3xl sm:text-4xl font-bold mt-1">
                  {fmtMoneyK(todaySnap.todayRevenue)}
                </div>
                <div className="text-xs opacity-70 mt-1">
                  {todaySnap.todayDealCount} deal{todaySnap.todayDealCount === 1 ? "" : "s"}
                  {todaySnap.sameDayLastWeekRevenue > 0 && (
                    <span className="ml-2">
                      ·{" "}
                      <span
                        className={
                          todaySnap.todayRevenue >= todaySnap.sameDayLastWeekRevenue
                            ? "text-ppp-green"
                            : "text-ppp-orange"
                        }
                      >
                        {todaySnap.todayRevenue >= todaySnap.sameDayLastWeekRevenue ? "▲" : "▼"}
                        {Math.abs(
                          Math.round(
                            ((todaySnap.todayRevenue - todaySnap.sameDayLastWeekRevenue) /
                              todaySnap.sameDayLastWeekRevenue) *
                              100
                          )
                        )}
                        %
                      </span>{" "}
                      vs same day last week
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right text-[11px] opacity-70">
                <div>Week:</div>
                <div className="font-condensed font-bold text-lg text-white">
                  {fmtMoneyK(todaySnap.weekRevenue)}
                </div>
              </div>
            </div>
            {todaySnap.biggestDealToday && (
              <div className="mt-4 pt-3 border-t border-white/20 text-[11px]">
                <span className="opacity-70">🏆 Biggest deal today:</span>{" "}
                <span className="font-medium">
                  {fmtMoneyK(todaySnap.biggestDealToday.amount)} ·{" "}
                  {todaySnap.biggestDealToday.account}
                  {todaySnap.biggestDealToday.rep && ` · ${todaySnap.biggestDealToday.rep}`}
                </span>
              </div>
            )}
            {/* Yesterday's quick reference — gives Alex a fast "what just
                happened" reference point alongside today's snapshot. */}
            {todaySnap.yesterdayRevenue > 0 && (
              <div className="mt-3 text-[11px] flex items-center justify-between gap-3 opacity-90">
                <span className="opacity-70">
                  Yesterday <span className="font-semibold text-white opacity-100">
                    {fmtMoneyK(todaySnap.yesterdayRevenue)}
                  </span>
                </span>
                {todaySnap.weekPriorRevenue > 0 && (
                  <span className="opacity-70 whitespace-nowrap">
                    Week-over-week:{" "}
                    <span
                      className={
                        todaySnap.weekRevenue >= todaySnap.weekPriorRevenue
                          ? "font-semibold text-ppp-green opacity-100"
                          : "font-semibold text-ppp-orange opacity-100"
                      }
                    >
                      {todaySnap.weekRevenue >= todaySnap.weekPriorRevenue ? "▲" : "▼"}
                      {Math.abs(
                        Math.round(
                          ((todaySnap.weekRevenue - todaySnap.weekPriorRevenue) /
                            todaySnap.weekPriorRevenue) *
                            100
                        )
                      )}
                      %
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Forecast card spanning 2 cols on lg */}
          <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">
                  Month Forecast
                </div>
                <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy mt-1">
                  {fmtMoneyK(forecast.projectedMonthEnd)}
                </div>
                <div className="text-xs text-ppp-charcoal-500 mt-1">
                  Projected month-end ·{" "}
                  <span
                    className={
                      forecast.vsLastMonthPct > 0
                        ? "text-ppp-green-700 font-semibold"
                        : forecast.vsLastMonthPct < 0
                        ? "text-ppp-orange-700 font-semibold"
                        : "text-ppp-charcoal-500"
                    }
                  >
                    {forecast.vsLastMonthPct > 0 ? "+" : ""}
                    {forecast.vsLastMonthPct}%
                  </span>{" "}
                  vs last month ({fmtMoneyK(forecast.lastMonthActual)})
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">
                  Day {forecast.daysElapsed} of {forecast.daysInMonth}
                </div>
                <div className="font-condensed text-lg font-bold text-ppp-charcoal mt-1">
                  {fmtMoneyK(forecast.monthToDateRevenue)}
                </div>
                <div className="text-[11px] text-ppp-charcoal-500">so far</div>
              </div>
            </div>

            {/* Simplified pace vs actual — single bar + clear delta callout.
                FIX: monthToDateRevenue and lastMonthActual are BOTH in $K, so
                ratios don't need the /1000. Expected = lastMonth * pacePct%. */}
            {(() => {
              const actualPct = forecast.lastMonthActual > 0
                ? Math.min(150, Math.round((forecast.monthToDateRevenue / forecast.lastMonthActual) * 100))
                : forecast.pacePct;
              const expectedRevByNow = Math.round(forecast.lastMonthActual * (forecast.pacePct / 100));
              const ahead = forecast.monthToDateRevenue >= expectedRevByNow;
              const gap = Math.abs(forecast.monthToDateRevenue - expectedRevByNow);
              const onPace = expectedRevByNow > 0 ? Math.abs(forecast.monthToDateRevenue - expectedRevByNow) / expectedRevByNow < 0.05 : false;

              return (
                <div className="space-y-3">
                  {/* The headline: on-pace status */}
                  <div className="flex items-baseline justify-between gap-2">
                    <div>
                      <div className="text-[11px] text-ppp-charcoal-500">
                        {forecast.daysRemaining} days left · {forecast.pacePct}% of month elapsed
                      </div>
                    </div>
                    {forecast.lastMonthActual > 0 && (
                      <div
                        className={
                          onPace
                            ? "text-[11px] font-semibold text-ppp-charcoal"
                            : ahead
                            ? "text-[11px] font-semibold text-ppp-green-700"
                            : "text-[11px] font-semibold text-ppp-orange-700"
                        }
                      >
                        {onPace ? (
                          <>● On pace</>
                        ) : ahead ? (
                          <>▲ {fmtMoneyK(gap)} ahead of pace</>
                        ) : (
                          <>▼ {fmtMoneyK(gap)} behind pace</>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Single progress bar — captures everything at a glance */}
                  <div>
                    <div className="flex justify-between text-[10px] text-ppp-charcoal-500 mb-1.5">
                      <span>
                        <strong className="text-ppp-navy">{fmtMoneyK(forecast.monthToDateRevenue)} captured</strong>
                        {forecast.lastMonthActual > 0 && (
                          <span className="ml-1.5 text-ppp-charcoal-400">
                            ({actualPct}% of last month&apos;s {fmtMoneyK(forecast.lastMonthActual)})
                          </span>
                        )}
                      </span>
                      <span>Target {fmtMoneyK(expectedRevByNow)}</span>
                    </div>
                    <div className="relative h-3 bg-ppp-charcoal-50 rounded-full overflow-hidden">
                      {/* Filled — actual */}
                      <div
                        className="absolute inset-y-0 left-0 bg-ppp-navy rounded-full transition-[width] duration-500"
                        style={{
                          width: `${Math.min(100, forecast.lastMonthActual > 0
                            ? (forecast.monthToDateRevenue / forecast.lastMonthActual) * 100
                            : 0)}%`,
                        }}
                      />
                      {/* Target line — vertical marker */}
                      {forecast.lastMonthActual > 0 && (
                        <div
                          className="absolute inset-y-0 w-0.5 bg-ppp-orange-700"
                          style={{ left: `calc(${forecast.pacePct}% - 1px)` }}
                          title={`Expected by today: ${fmtMoneyK(expectedRevByNow)}`}
                        />
                      )}
                    </div>
                    <div className="mt-1 text-[10px] text-ppp-charcoal-500 flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-sm bg-ppp-navy" /> Actual
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-0.5 bg-ppp-orange-700" /> Today&apos;s target
                      </span>
                      {velocity && velocity.sampleCount > 10 && (
                        <span className="ml-auto">
                          Quote→Job avg:{" "}
                          <strong className="text-ppp-charcoal">{velocity.avgDays}d</strong>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </section>
      )}

      {/* ─── KPI row ─── */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KPICard
            label="Revenue Sold"
            value={fmtMoneyK(revenueKpi.value)}
            change={period === "lifetime" ? "All time" : `${sign(revenueKpi.change)}% vs prior`}
            trend={period === "lifetime" ? "flat" : revenueKpi.trend}
            accent="blue"
          />
          <KPICard
            label="Conversion Rate"
            value={`${(liveKpis?.closeRate ?? view.kpis.closeRate.value).toFixed(1)}%`}
            change={
              liveKpis
                ? "Opps → Work Orders"
                : `${sign(view.kpis.closeRate.change)} pts`
            }
            trend={liveKpis ? "flat" : view.kpis.closeRate.trend}
            accent="green"
          />
          <KPICard
            label="Avg Ticket"
            value={fmtMoneyK(liveKpis?.avgTicket ?? view.kpis.avgTicket.value)}
            change={
              liveKpis
                ? "Per deal with revenue"
                : `${sign(view.kpis.avgTicket.change)}%`
            }
            trend={liveKpis ? "flat" : view.kpis.avgTicket.trend}
            accent="orange"
          />
          <KPICard
            label={liveKpis ? "Open Pipeline" : "Open Quotes"}
            value={
              liveKpis
                ? fmtMoneyK(liveKpis.openPipelineK)
                : view.kpis.openQuotes.value.toString()
            }
            change={liveKpis ? "Not yet committed" : sign(view.kpis.openQuotes.change)}
            trend={liveKpis ? "flat" : view.kpis.openQuotes.trend}
            accent="blue"
          />
        </div>
      </section>

      {/* ─── Revenue trend ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 sm:gap-4">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">
                Revenue · {PERIOD_LABELS[period]}
              </h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                {trendSeries.length === 0
                  ? "No closed-won activity in this period yet."
                  : period === "7d" || period === "30d"
                  ? `Daily revenue across ${trendSeries.length} day${trendSeries.length === 1 ? "" : "s"}. Hover or tap a point for the top region + top rep that day.`
                  : `Monthly revenue across ${trendSeries.length} month${trendSeries.length === 1 ? "" : "s"}. Hover or tap a point for the top region + top rep that month.`}
              </p>
            </div>
            <div className="sm:text-right">
              <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy tracking-tight">
                {fmtMoneyK(revenueKpi.value)}
              </div>
              <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                {PERIOD_LABELS[period]} total
              </div>
            </div>
          </div>
          <div className="mt-5">
            <TrendChart
              data={trendSeries}
              colorToken="ppp-blue"
              yFormat="currency-k"
              heightClassName="h-[200px] sm:h-[260px]"
            />
          </div>
        </div>
      </section>

      {/* ─── Top customers by lifetime revenue ─── */}
      {topCustomers.length > 0 && (
        <section>
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-semibold text-ppp-charcoal">Top Customers</h3>
                <p className="text-xs text-ppp-charcoal-500 mt-1">
                  By lifetime revenue across all Work Orders
                </p>
              </div>
              <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">
                Top {topCustomers.length}
              </div>
            </div>
            <ul className="divide-y divide-ppp-charcoal-100">
              {topCustomers.map((c, i) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="font-condensed text-xs font-bold text-ppp-charcoal-500 w-5 shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ppp-charcoal truncate flex items-center gap-2">
                      {c.name}
                      {c.isRepeat && (
                        <span className="inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold border text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100">
                          Repeat
                        </span>
                      )}
                      {c.isKey && (
                        <span className="inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold border text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100">
                          Key
                        </span>
                      )}
                    </div>
                    {(c.region || c.lastWorkOrderCompleted) && (
                      <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                        {c.region}
                        {c.region && c.lastWorkOrderCompleted && " · "}
                        {c.lastWorkOrderCompleted && `Last job ${c.lastWorkOrderCompleted}`}
                      </div>
                    )}
                  </div>
                  <span className="font-condensed font-bold text-ppp-navy whitespace-nowrap">
                    {fmtMoneyK(c.lifetimeRevenue / 1000)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ─── Service line mix + Regional performance ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Service Line Mix</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-5">
            Residential vs Commercial share of revenue · {PERIOD_LABELS[period].toLowerCase()}
          </p>

          {view.serviceLineMix.residential.revenue + view.serviceLineMix.commercial.revenue === 0 ? (
            <EmptyHint message="No revenue in this filter." />
          ) : (
            <>
              <div className="flex h-3 w-full rounded-full overflow-hidden mb-5">
                <div
                  className="bg-ppp-blue transition-[width] duration-500"
                  style={{ width: `${view.serviceLineMix.residential.pct}%` }}
                  title={`Residential ${view.serviceLineMix.residential.pct}%`}
                />
                <div
                  className="bg-ppp-orange transition-[width] duration-500"
                  style={{ width: `${view.serviceLineMix.commercial.pct}%` }}
                  title={`Commercial ${view.serviceLineMix.commercial.pct}%`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <MixCard
                  label="Residential"
                  revenue={view.serviceLineMix.residential.revenue}
                  pct={view.serviceLineMix.residential.pct}
                  reps={view.serviceLineMix.residential.reps}
                  avgTicket={view.serviceLineMix.residential.avgTicket}
                  accent="blue"
                />
                <MixCard
                  label="Commercial"
                  revenue={view.serviceLineMix.commercial.revenue}
                  pct={view.serviceLineMix.commercial.pct}
                  reps={view.serviceLineMix.commercial.reps}
                  avgTicket={view.serviceLineMix.commercial.avgTicket}
                  accent="orange"
                />
              </div>
            </>
          )}
        </div>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Regional Performance</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-5">
            Revenue sold by region · {PERIOD_LABELS[period].toLowerCase()}
          </p>

          {view.regionalRollup.length === 0 || view.regionalRollup.every((r) => r.revenue === 0) ? (
            <EmptyHint message="No regional revenue in this filter." />
          ) : (
            <HorizontalBar
              rows={[...view.regionalRollup]
                .sort((a, b) => b.revenue - a.revenue)
                .map((r) => ({
                  label: r.region,
                  value: r.revenue,
                  sublabel: `${r.reps} rep${r.reps === 1 ? "" : "s"} · ${r.closeRate.toFixed(1)}% close`,
                  colorToken: getRegionColorToken(r.region),
                }))}
              formatValue={fmtMoneyK}
            />
          )}
        </div>
      </section>

      {/* ─── Pipeline funnel + Insights ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">Pipeline Activity</h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                Per-stage activity · {PERIOD_LABELS[effectiveFunnelPeriod].toLowerCase()}
              </p>
              {snapshot && (
                <p className="text-[10px] text-ppp-charcoal-400 mt-1 italic">
                  Period totals only — not cohort conversion (Opps won this month may have been quoted earlier)
                </p>
              )}
            </div>
            <FilterDropdown<Period | "page">
              value={funnelPeriod}
              options={[
                { value: "page", label: "Match page filter" },
                ...PERIOD_OPTIONS,
              ]}
              onChange={setFunnelPeriod}
              srLabel="Funnel period"
              icon={<IconCalendar />}
            />
          </div>

          {funnel[0].count === 0 ? (
            <EmptyHint message="No pipeline activity in this filter." />
          ) : (
            <div className="space-y-3">
              {funnel.map((s, i) => {
                const max = Math.max(...funnel.map((x) => x.count), 1);
                const pct = Math.max(8, Math.round((s.count / max) * 100));
                const nextDrop =
                  i < funnel.length - 1 && s.count > 0
                    ? Math.round(((s.count - funnel[i + 1].count) / s.count) * 100)
                    : null;
                return (
                  <div key={s.stage}>
                    <div className="flex items-baseline justify-between mb-1.5 gap-2">
                      <span className="text-sm font-semibold text-ppp-charcoal">{s.stage}</span>
                      <span className="text-sm font-semibold text-ppp-charcoal shrink-0">
                        {s.count.toLocaleString()}
                        {s.value > 0 && (
                          <span className="ml-2 text-[11px] text-ppp-charcoal-500">
                            {fmtMoneyK(s.value)}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="relative h-7 w-full bg-ppp-charcoal-50 rounded">
                      <div
                        className={[
                          "h-full rounded transition-[width] duration-500",
                          i === funnel.length - 1
                            ? "bg-ppp-green"
                            : i === funnel.length - 2
                            ? "bg-ppp-orange"
                            : "bg-ppp-blue",
                        ].join(" ")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {nextDrop !== null && !snapshot && (
                      <div className="text-[11px] text-ppp-charcoal-500 mt-1">
                        {nextDrop}% drop-off to next stage
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-3 sm:space-y-4">
          {/* Top Performer collapses to the viewer themselves when scoped — hide. */}
          {!repScopedToSelf && (topPerformer ? (
            <Link
              href={`/dashboard/rep/${topPerformer.id}`}
              className="block bg-white border border-ppp-charcoal-100 rounded-xl p-5 hover:border-ppp-green-200 hover:shadow-md hover:shadow-ppp-charcoal/5 transition-all"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-md bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-xs font-bold">
                  ↑
                </div>
                <h3 className="text-sm font-semibold text-ppp-charcoal">Top Performer</h3>
              </div>
              <div className="font-semibold text-ppp-charcoal">{topPerformer.name}</div>
              <div className="text-xs text-ppp-charcoal-500 mt-0.5">{topPerformer.region}</div>
              <div className="mt-3 flex items-baseline gap-3">
                <div className="font-condensed text-2xl font-bold text-ppp-green-700">{fmtMoneyK(topPerformer.revenue)}</div>
                <div className="text-xs text-ppp-charcoal-500">{topPerformer.closeRate.toFixed(1)}% conv</div>
              </div>
              <div className="mt-3 text-[11px] font-medium text-ppp-blue">View deep-dive →</div>
            </Link>
          ) : (
            <div className="block bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-md bg-ppp-charcoal-50 text-ppp-charcoal-500 flex items-center justify-center text-xs font-bold">
                  —
                </div>
                <h3 className="text-sm font-semibold text-ppp-charcoal">Top Performer</h3>
              </div>
              <p className="text-xs text-ppp-charcoal-500 mt-2">
                No closed revenue in this period yet.
              </p>
            </div>
          ))}

          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-md bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-xs font-bold">
                !
              </div>
              <h3 className="text-sm font-semibold text-ppp-charcoal">Pipeline at Risk</h3>
            </div>
            <div className="font-condensed text-2xl font-bold text-ppp-orange">{fmtMoneyK(pipelineAtRisk.value)}</div>
            <div className="text-xs text-ppp-charcoal-500 mt-0.5">
              {pipelineAtRisk.count} deals · {pipelineAtRisk.reps} reps · {">"}14 days in stage
            </div>
            {/* "Review stuck deals" used to be a no-op button — point it at
                the rep list instead so admins can drill in to the reps with
                stale pipeline. (A full stuck-deals filter view is a Phase 2
                follow-up.) */}
            <Link
              href="/dashboard/rep"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ppp-blue hover:text-ppp-blue-700 transition-colors"
            >
              Review reps with stuck deals
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h14 M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>

          {/* Hot reps this week — momentum spotlight. Hide when scoped to self
              (a 1-row leaderboard comparing the viewer to themselves is noise).
              When all reps are below the $1K WoW threshold, show a quiet
              empty-state instead of dropping the card silently. */}
          {!repScopedToSelf && (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-md bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-xs">
                  🔥
                </div>
                <h3 className="text-sm font-semibold text-ppp-charcoal">Hot This Week</h3>
              </div>
              {hotReps.length === 0 ? (
                <p className="text-xs text-ppp-charcoal-500 italic">
                  No reps with &gt;$1K week-over-week growth yet.
                </p>
              ) : (
                <>
                  <ul className="space-y-1.5">
                    {hotReps.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                        <Link
                          href={`/dashboard/rep/${r.id}`}
                          className="font-medium text-ppp-charcoal hover:text-ppp-blue transition-colors truncate"
                        >
                          {r.name}
                        </Link>
                        <span className="whitespace-nowrap text-right">
                          <span className="font-semibold text-ppp-navy">{fmtMoneyK(r.thisWeekK)}</span>
                          {r.deltaPct !== 0 && (
                            <span
                              className={
                                r.deltaPct > 0
                                  ? "ml-2 text-ppp-green-700 font-semibold"
                                  : "ml-2 text-ppp-orange-700 font-semibold"
                              }
                            >
                              {r.deltaPct > 0 ? "▲" : "▼"}
                              {Math.abs(r.deltaPct)}%
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 text-[10px] text-ppp-charcoal-500 italic">
                    Week-over-week revenue delta
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ─── Rep leaderboard ─── */}
      <section>
        <Leaderboard
          reps={view.leaderboard}
          teamRevenueTotal={view.leaderboard.reduce((s, r) => s + r.revenueSold, 0)}
        />
      </section>
    </div>
  );
}

function MixCard({
  label,
  revenue,
  pct,
  reps,
  avgTicket,
  accent,
}: {
  label: string;
  revenue: number;
  pct: number;
  reps: number;
  avgTicket: number;
  accent: "blue" | "orange";
}) {
  const styles = {
    blue: {
      border: "border-ppp-blue-100",
      bg: "bg-ppp-blue-50/40",
      dot: "bg-ppp-blue",
      label: "text-ppp-blue-700",
    },
    orange: {
      border: "border-ppp-orange-100",
      bg: "bg-ppp-orange-50/40",
      dot: "bg-ppp-orange",
      label: "text-ppp-orange-700",
    },
  }[accent];

  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} p-3 sm:p-4`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
        <span className={`font-condensed text-[11px] font-semibold tracking-wide uppercase ${styles.label}`}>
          {label}
        </span>
      </div>
      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">{fmtMoneyK(revenue)}</div>
      <div className="mt-1 text-[11px] text-ppp-charcoal-500">
        {pct}% of revenue · {reps} rep{reps === 1 ? "" : "s"}
        {avgTicket > 0 && ` · avg ${fmtMoneyK(avgTicket)}`}
      </div>
    </div>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="text-center py-8">
      <p className="text-sm text-ppp-charcoal-500">{message}</p>
      <p className="text-[11px] text-ppp-charcoal-500/80 mt-1">
        Try a wider period or a different region.
      </p>
    </div>
  );
}

function IconCalendar() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18 M8 3v4 M16 3v4" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}
