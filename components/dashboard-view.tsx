"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import FilterDropdown from "@/components/filter-dropdown";
import HorizontalBar from "@/components/horizontal-bar";
import KPICard from "@/components/kpi-card";
import Leaderboard from "@/components/leaderboard";
import PageHeader from "@/components/page-header";
import TrendChart from "@/components/trend-chart";
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
} from "@/lib/salesforce/derive";
import type { LiveDashboardBundle } from "@/lib/data-source";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  ["lifetime", "30d", "90d", "6m", "12m", "ytd"] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

function fmtMoneyK(v: number) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}M`;
  return `$${Math.round(v)}K`;
}

function sign(n: number) {
  return n > 0 ? `+${n}` : `${n}`;
}

type Props = {
  bundle: LiveDashboardBundle;
};

export default function DashboardView({ bundle }: Props) {
  // Default to "lifetime" (matches PPP's Salesforce report which has no date scope).
  // Other periods are opt-in via the dropdown.
  const [period, setPeriod] = useState<Period>("lifetime");
  const [region, setRegion] = useState<RegionFilter>("all");
  const [funnelPeriod, setFunnelPeriod] = useState<Period | "page">("page");

  const dataSource = bundle.source;
  const dataSourceReason = bundle.reason;
  const snapshot = bundle.snapshot;

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

  // Top performer (live or mock).
  const topPerformer = useMemo(() => {
    if (snapshot) return deriveTopPerformer(snapshot, period) ?? mockTopPerformer;
    return mockTopPerformer;
  }, [snapshot, period]);

  // Pipeline at risk (live or mock).
  const pipelineAtRisk = useMemo(() => {
    if (snapshot) return derivePipelineAtRisk(snapshot) ?? mockPipelineAtRisk;
    return mockPipelineAtRisk;
  }, [snapshot]);

  // Pipeline funnel can show either the page-level period or its own override.
  const funnel = useMemo(() => {
    if (funnelPeriod === "page") return view.pipelineFunnel;
    return getFunnelForPeriod(funnelPeriod, region, reps);
  }, [funnelPeriod, view.pipelineFunnel, region, reps]);

  const effectiveFunnelPeriod: Period = funnelPeriod === "page" ? period : funnelPeriod;

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-up">
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
            label="Close Rate"
            value={`${(liveKpis?.closeRate ?? view.kpis.closeRate.value).toFixed(1)}%`}
            change={
              liveKpis
                ? "Avg across active reps"
                : `${sign(view.kpis.closeRate.change)} pts`
            }
            trend={liveKpis ? "flat" : view.kpis.closeRate.trend}
            accent="green"
          />
          <KPICard
            label="Avg Ticket"
            value={`$${(liveKpis?.avgTicket ?? view.kpis.avgTicket.value).toFixed(1)}K`}
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
              formatValue={(v) => `$${v}K`}
            />
          )}
        </div>
      </section>

      {/* ─── Pipeline funnel + Insights ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">Pipeline Funnel</h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                Lead → quote → closed deal · {PERIOD_LABELS[effectiveFunnelPeriod].toLowerCase()}
              </p>
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
                            ${s.value.toLocaleString()}K
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
                    {nextDrop !== null && (
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
              <div className="font-condensed text-2xl font-bold text-ppp-green-700">${topPerformer.revenue}K</div>
              <div className="text-xs text-ppp-charcoal-500">{topPerformer.closeRate}% close</div>
            </div>
            <div className="mt-3 text-[11px] font-medium text-ppp-blue">View deep-dive →</div>
          </Link>

          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-md bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-xs font-bold">
                !
              </div>
              <h3 className="text-sm font-semibold text-ppp-charcoal">Pipeline at Risk</h3>
            </div>
            <div className="font-condensed text-2xl font-bold text-ppp-orange">${pipelineAtRisk.value}K</div>
            <div className="text-xs text-ppp-charcoal-500 mt-0.5">
              {pipelineAtRisk.count} deals · {pipelineAtRisk.reps} reps · {">"}14 days in stage
            </div>
            <button
              type="button"
              className="mt-3 text-xs font-medium text-ppp-blue hover:text-ppp-blue-700"
            >
              Review stuck deals →
            </button>
          </div>
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
      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">${revenue}K</div>
      <div className="mt-1 text-[11px] text-ppp-charcoal-500">
        {pct}% of revenue · {reps} rep{reps === 1 ? "" : "s"}
        {avgTicket > 0 && ` · avg $${avgTicket}K`}
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
