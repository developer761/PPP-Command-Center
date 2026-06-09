"use client";

/**
 * Dashboard View — /dashboard (home).
 *
 * The first surface admins + reps land on after sign-in. Mix of company-wide
 * KPIs (admins) + per-rep summary (reps in "my" scope).
 *
 * WHAT IT RENDERS:
 *   - Period selector (this-month / last-month / this-quarter / FY / etc.)
 *   - Region filter chips (drives derived shapes via `getFilteredView`)
 *   - KPI strip (revenue, close rate, deals won, etc.)
 *   - Top performer card + period delta
 *   - Pipeline at risk
 *   - Recent activity feed (last-N-hours rollup)
 *   - Trend chart + region rollup table
 *
 * DATA SOURCES (all passed as props by page.tsx via `loadDashboardData`):
 *   - bundle.snapshot — the full SF snapshot, already viewer-scoped
 *   - bundle.viewer — admin vs rep distinction drives which cards show
 *   - Period + region filter state — URL-synced so links + back button work
 *
 * Derived shapes read from `lib/salesforce/derive.ts` — every derive
 * there is memoized per-snapshot, so flipping period/region is instant
 * after the first compute.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FilterDropdown from "@/components/filter-dropdown";
import HorizontalBar from "@/components/horizontal-bar";
import KPICard from "@/components/kpi-card";
import Leaderboard from "@/components/leaderboard";
import PageHeader from "@/components/page-header";
import TrendChart from "@/components/trend-chart";
import EmptyScopeBanner from "@/components/empty-scope-banner";
import RecentActivityFeed from "@/components/recent-activity-feed";
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
  /** Customer-form pipeline summary across all visible WOs — sent / opened /
   *  submitted / expired counts. Drives the new "Color Forms" home card so
   *  Alex sees "did Mrs. Smith pick her colors?" without navigating to
   *  Materials Ordering. Server-loaded in app/dashboard/page.tsx. */
  formSummary?: {
    sent: number;
    opened: number;
    submitted: number;
    expired: number;
    total: number;
  };
};

export default function DashboardView({ bundle, formSummary }: Props) {
  // Both `period` and `region` filters are URL-persisted (with localStorage
  // as a fallback when navigating in from a clean URL). Karan: filters should
  // survive clicking into a customer + hitting back, since the dashboard is
  // a 5-min-a-day read for Alex and the filters scope the entire session.
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlPeriod = searchParams.get("period") as Period | null;
  const urlRegion = searchParams.get("region");

  // Default to "This Month" when no URL/storage value — PPP's day-to-day
  // mental model is month-by-month, SF reports default to similar windows.
  const ALLOWED_PERIODS: Period[] = [
    "lifetime", "this-month", "last-month", "this-year", "last-year",
    "7d", "30d", "90d", "6m", "12m", "ytd",
  ];
  const isValidPeriod = (v: string | null): v is Period =>
    v !== null && (ALLOWED_PERIODS as string[]).includes(v);

  const [period, setPeriodState] = useState<Period>(() =>
    isValidPeriod(urlPeriod) ? urlPeriod : "this-month"
  );
  const [region, setRegionState] = useState<RegionFilter>(() => urlRegion ?? "all");

  // Restore each filter independently from localStorage on mount. Fires
  // when EITHER param is missing from the URL (a deep link like
  // /dashboard?region=Nassau should still restore the user's saved period).
  // Honors URL params over localStorage so a shared deep link wins. One
  // router.replace on mount maxes out — no double-write race.
  useEffect(() => {
    if (urlPeriod && urlRegion) return;
    if (typeof window === "undefined") return;
    try {
      const next: Record<string, string> = {};
      // Only restore each filter if the URL didn't already set it.
      if (!urlPeriod) {
        const savedPeriod = window.localStorage.getItem("dashboard_period");
        if (savedPeriod && isValidPeriod(savedPeriod) && savedPeriod !== "this-month") {
          setPeriodState(savedPeriod);
          next.period = savedPeriod;
        }
      }
      if (!urlRegion) {
        const savedRegion = window.localStorage.getItem("dashboard_region");
        if (savedRegion && savedRegion !== "all") {
          setRegionState(savedRegion);
          next.region = savedRegion;
        }
      }
      if (Object.keys(next).length > 0) {
        const params = new URLSearchParams(searchParams.toString());
        for (const [k, v] of Object.entries(next)) params.set(k, v);
        router.replace(`/dashboard?${params.toString()}`, { scroll: false });
      }
    } catch {
      // localStorage can throw in private mode / unsupported envs — silent
      // fall-back to defaults is fine.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Set period + persist to URL + localStorage. The default ("this-month")
   *  is omitted from the URL so a clean `?` doesn't carry a redundant
   *  param when the user just resets to default. */
  const setPeriod = (next: Period) => {
    setPeriodState(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("dashboard_period", next);
      }
    } catch {
      // ignore
    }
    const params = new URLSearchParams(searchParams.toString());
    if (next === "this-month") params.delete("period");
    else params.set("period", next);
    const qs = params.toString();
    router.replace(qs ? `/dashboard?${qs}` : "/dashboard", { scroll: false });
  };

  /** Set region + persist to URL + localStorage in one shot. Use everywhere
   *  the dropdown changes value so the three sources stay in sync. */
  const setRegion = (next: RegionFilter) => {
    setRegionState(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("dashboard_region", next);
      }
    } catch {
      // ignore localStorage write failures
    }
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("region");
    else params.set("region", next);
    const qs = params.toString();
    router.replace(qs ? `/dashboard?${qs}` : "/dashboard", { scroll: false });
  };
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
    // Canonical rep universe only (FPRC §B) — admins/office staff would
    // otherwise dilute the company averages. Mock reps (isFieldStandard
    // undefined) are treated as field. ALSO honor the Region filter so the
    // headline cards re-scope with it (previously they stayed company-wide
    // while only the lower cards narrowed — a confusing split-brain filter).
    const regionScoped = region === "all" ? reps : reps.filter((r) => r.region === region);
    const fieldReps = regionScoped.filter((r) => r.isFieldStandard !== false);
    const totalRevenue = fieldReps.reduce((s, r) => s + r.revenueSold, 0); // $K
    const openPipelineK = fieldReps.reduce((s, r) => s + r.openPipeline, 0);
    // Ratios are WEIGHTED (Σnumerator ÷ Σdenominator), never mean-of-means
    // (FPRC §C). closeRate weighted by quotesSent, avgTicket by
    // appointmentsHeld — matching the rep-page team-average pattern so the
    // two surfaces tell one consistent story.
    const totalQuotes = fieldReps.reduce((s, r) => s + r.quotesSent, 0);
    const totalAppts = fieldReps.reduce((s, r) => s + r.appointmentsHeld, 0);
    const closeRate = totalQuotes > 0
      ? fieldReps.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) / totalQuotes
      : 0;
    const avgTicket = totalAppts > 0
      ? fieldReps.reduce((s, r) => s + r.avgTicket * r.appointmentsHeld, 0) / totalAppts
      : 0;
    return {
      totalRevenue,
      closeRate: +closeRate.toFixed(1),
      avgTicket: +avgTicket.toFixed(1),
      openPipelineK,
    };
  }, [snapshot, reps, region]);

  // Company Conversion Rate = Leads → Opps over the trailing 365d (Katie
  // 2026-05-29). Aggregate counts ride along in the snapshot; null hides the
  // card when there's no lead data.
  const conversionRate =
    snapshot && snapshot.leadStats && snapshot.leadStats.total > 0
      ? (snapshot.leadStats.converted / snapshot.leadStats.total) * 100
      : null;

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

  // ─── Customer Pulse: high-LTV customers we haven't worked with in 12+
  // months. Surfaces re-engagement opportunities (PPP's repeat-customer
  // book is one of the most profitable channels per Karan). Sorted by
  // lifetime $ desc so the biggest dormant accounts surface first.
  // Honors the region filter so when Alex narrows to "Nassau," he sees
  // Nassau's dormant customers, not Suffolk's. Hidden entirely when no
  // candidates.
  const customerPulse = useMemo(() => {
    if (!snapshot) return [];
    const TWELVE_MONTHS_MS = 365 * 86_400_000;
    const now = Date.now();
    type PulseRow = {
      id: string;
      name: string;
      lifetimeRevenue: number;
      monthsSince: number;
      lastWorkOrderCompleted: string;
    };
    const candidates: PulseRow[] = [];
    for (const a of snapshot.accounts) {
      if (a.totalLifetimeRevenue <= 0) continue;
      if (!a.lastWorkOrderCompleted) continue;
      // Region filter — when Alex narrows to a region, Pulse should reflect
      // that scope. Accounts without a region tag are excluded from a
      // filtered view (we can't confidently place them).
      if (region !== "all" && a.region !== region) continue;
      const last = new Date(a.lastWorkOrderCompleted).getTime();
      if (isNaN(last)) continue;
      const ageMs = now - last;
      if (ageMs < TWELVE_MONTHS_MS) continue;
      candidates.push({
        id: a.id,
        name: a.name,
        lifetimeRevenue: a.totalLifetimeRevenue,
        monthsSince: Math.round(ageMs / (30 * 86_400_000)),
        lastWorkOrderCompleted: a.lastWorkOrderCompleted,
      });
    }
    return candidates
      .sort((a, b) => b.lifetimeRevenue - a.lifetimeRevenue)
      .slice(0, 5);
  }, [snapshot, region]);

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
        <div className={`grid grid-cols-2 ${conversionRate !== null ? "lg:grid-cols-5" : "lg:grid-cols-4"} gap-3 sm:gap-4`}>
          <KPICard
            label="Revenue Sold"
            // Region-scoped revenue (from the filtered reps) when a region is
            // selected, so this card agrees with the other three; company-wide
            // period-delta otherwise.
            value={fmtMoneyK(snapshot && region !== "all" && liveKpis ? liveKpis.totalRevenue : revenueKpi.value)}
            change={
              snapshot && region !== "all"
                // Region-scoped: show a neutral descriptor parallel to the other
                // cards ("Sold ÷ Opps", "Per deal with revenue", …) rather than
                // restating the region (already in the page subtitle). A true
                // region-scoped prior-period delta isn't cheaply available here.
                ? "Sold this period"
                : period === "lifetime" ? "All time" : `${sign(revenueKpi.change)}% vs prior`
            }
            trend={snapshot && region !== "all" ? "flat" : period === "lifetime" ? "flat" : revenueKpi.trend}
            accent="blue"
            hint="Total revenue from work orders that closed in the selected period. Compared to the same window one period earlier."
          />
          <KPICard
            label="Close Rate"
            value={`${(liveKpis?.closeRate ?? view.kpis.closeRate.value).toFixed(1)}%`}
            change={
              liveKpis
                ? "Sold ÷ Opps"
                : `${sign(view.kpis.closeRate.change)} pts`
            }
            trend={liveKpis ? "flat" : view.kpis.closeRate.trend}
            accent="green"
            hint="Of all the opportunities created in the period, what share became real paid jobs. Higher is better — it means quotes are turning into work."
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
            hint="Average dollar size of a closed-won deal in the period. Rising means we're winning bigger jobs; falling means smaller jobs or a price-mix shift."
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
            hint="Dollars in opportunities still in progress (not yet won or lost). This is the runway — what could still close this quarter."
          />
          {conversionRate !== null && (
            <KPICard
              label="Conversion Rate"
              value={`${conversionRate.toFixed(1)}%`}
              change="Leads → Opps · 12mo"
              trend="flat"
              accent="green"
              hint="Of all the leads that came in over the last 12 months, what share turned into a real opportunity. Measures the top of the funnel — marketing + intake."
            />
          )}
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
                  By lifetime revenue across all Work Orders · click a name to see full history
                </p>
              </div>
              <Link
                href="/dashboard/customers"
                className="text-[11px] font-semibold text-ppp-blue-700 hover:text-ppp-blue-800 hover:underline whitespace-nowrap"
              >
                All customers →
              </Link>
            </div>
            <ul className="divide-y divide-ppp-charcoal-100">
              {topCustomers.map((c, i) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="font-condensed text-xs font-bold text-ppp-charcoal-500 w-5 shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate flex items-center gap-2">
                      <Link
                        href={`/dashboard/customer/${encodeURIComponent(c.id)}`}
                        className="text-ppp-charcoal hover:text-ppp-blue hover:underline transition-colors"
                      >
                        {c.name}
                      </Link>
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

      {/* ─── Customer Pulse: dormant high-LTV accounts ───
          Renders only when there's at least one candidate; never an
          empty card. Sits below Top Customers so Alex reads "biggest
          customers" → "biggest customers we should re-engage" as a
          natural pair. */}
      {customerPulse.length > 0 && (
        <section>
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-semibold text-ppp-charcoal">
                  Customers to reach out to
                </h3>
                <p className="text-xs text-ppp-charcoal-500 mt-1">
                  High-lifetime customers we haven&apos;t worked with in 12+ months
                </p>
              </div>
              <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">
                {customerPulse.length}
              </div>
            </div>
            <ul className="divide-y divide-ppp-charcoal-100">
              {customerPulse.map((c, i) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="font-condensed text-xs font-bold text-ppp-charcoal-500 w-5 shrink-0">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      <Link
                        href={`/dashboard/customer/${encodeURIComponent(c.id)}`}
                        className="text-ppp-charcoal hover:text-ppp-blue hover:underline transition-colors"
                      >
                        {c.name}
                      </Link>
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                      Last job {c.monthsSince} mo ago
                    </div>
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
                <div className="text-xs text-ppp-charcoal-500">{topPerformer.closeRate.toFixed(1)}% close</div>
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
            {/* Drill-in points at /dashboard/stuck — focused deal-level
                list (customer + owner + amount + days-idle) sorted by
                dollar exposure desc. Replaces the previous /dashboard/rep
                redirect which was the rep leaderboard, not actionable. */}
            <Link
              href="/dashboard/stuck"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ppp-blue hover:text-ppp-blue-700 transition-colors"
            >
              See which deals are stalling →
            </Link>
          </div>

          {/* Recent Activity — last 24h rollup of every event across the
              customer-form / supplier-order / inbox pipelines. Polls every
              60s so it stays fresh while admin watches. Hidden when nothing
              recent so the day-0 dashboard stays clean. */}
          <RecentActivityFeed />

          {/* Customer Color Forms summary — Alex's #2 audit ask. Was buried
              on /dashboard/materials; surfacing here so "did Mrs. Smith pick
              her colors yet?" is answerable from the home dashboard. Hidden
              when zero forms in flight (cleans up day-0 view). */}
          {formSummary && formSummary.total > 0 && (
            <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-md bg-ppp-blue-50 text-ppp-blue-700 flex items-center justify-center text-xs font-bold">
                  ✉
                </div>
                <h3 className="text-sm font-semibold text-ppp-charcoal">Color Forms</h3>
              </div>
              <div className="font-condensed text-2xl font-bold text-ppp-navy">
                {formSummary.submitted}
                <span className="text-base font-normal text-ppp-charcoal-500"> / {formSummary.total}</span>
              </div>
              <div className="text-xs text-ppp-charcoal-500 mt-0.5">
                {formSummary.submitted === formSummary.total
                  ? "All submitted ✓"
                  : "submitted by customers"}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                {formSummary.submitted > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100">
                    ✓ {formSummary.submitted}
                  </span>
                )}
                {formSummary.opened > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-100">
                    👁 {formSummary.opened}
                  </span>
                )}
                {formSummary.sent > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-ppp-charcoal-50 text-ppp-charcoal border-ppp-charcoal-100">
                    📨 {formSummary.sent}
                  </span>
                )}
                {formSummary.expired > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded border bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100">
                    ⏳ {formSummary.expired}
                  </span>
                )}
              </div>
              <Link
                href="/dashboard/materials"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ppp-blue hover:text-ppp-blue-700 transition-colors"
              >
                Manage materials orders →
              </Link>
            </div>
          )}

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
