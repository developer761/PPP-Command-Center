import Link from "next/link";
import KPICard from "@/components/kpi-card";
import PageHeader from "@/components/page-header";
import TrendChart from "@/components/trend-chart";
import HorizontalBar from "@/components/horizontal-bar";
import {
  reps,
  companyKPIs,
  topPerformer,
  pipelineAtRisk,
  monthlyCompany,
  serviceLineMix,
  regionalRollup,
  pipelineFunnel,
  teamTotals,
} from "@/lib/mock-data";

function fmt(v: number, unit: "$K" | "%" | "" = "") {
  if (unit === "$K") return `$${v}K`;
  if (unit === "%") return `${v.toFixed(1)}%`;
  return v.toString();
}

function sign(n: number) {
  return n > 0 ? `+${n}` : n.toString();
}

const REGION_COLOR: Record<string, string> = {
  Suffolk: "ppp-blue",
  Nassau: "ppp-green",
  Queens: "ppp-orange",
  Brooklyn: "ppp-blue-600",
};

export default function DashboardPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        title="Company Overview"
        subtitle="Whole-company analytics · last 30 days · all regions"
        actions={
          <div className="flex items-center gap-2 text-xs">
            <span className="px-3 py-1.5 bg-white border border-ppp-charcoal-100 rounded-lg font-medium text-ppp-charcoal-500">
              All Regions
            </span>
            <span className="px-3 py-1.5 bg-white border border-ppp-charcoal-100 rounded-lg font-medium text-ppp-charcoal-500">
              Last 30 days
            </span>
          </div>
        }
      />

      {/* ─── KPI row ─── */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            label="Revenue Sold"
            value={fmt(companyKPIs.revenueSold.value, "$K")}
            change={`${sign(companyKPIs.revenueSold.change)}%`}
            trend={companyKPIs.revenueSold.trend}
            accent="blue"
          />
          <KPICard
            label="Close Rate"
            value={fmt(companyKPIs.closeRate.value, "%")}
            change={`${sign(companyKPIs.closeRate.change)} pts`}
            trend={companyKPIs.closeRate.trend}
            accent="green"
          />
          <KPICard
            label="Avg Ticket"
            value={fmt(companyKPIs.avgTicket.value, "$K")}
            change={`${sign(companyKPIs.avgTicket.change)}%`}
            trend={companyKPIs.avgTicket.trend}
            accent="orange"
          />
          <KPICard
            label="Open Quotes"
            value={fmt(companyKPIs.openQuotes.value)}
            change={sign(companyKPIs.openQuotes.change)}
            trend={companyKPIs.openQuotes.trend}
            accent="blue"
          />
        </div>
      </section>

      {/* ─── 12-month revenue trend ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <div className="flex items-baseline justify-between mb-1">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">
                Revenue · Last 12 Months
              </h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                Company-wide monthly revenue sold across Residential + Commercial. Spring uptick visible.
              </p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-ppp-charcoal tracking-tight">
                ${monthlyCompany.reduce((s, m) => s + m.revenue, 0).toLocaleString()}K
              </div>
              <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                Trailing 12-month total
              </div>
            </div>
          </div>
          <div className="mt-5">
            <TrendChart
              data={monthlyCompany.map((m) => ({ label: m.month, value: m.revenue }))}
              colorToken="ppp-blue"
              yFormat="currency-k"
              height={240}
            />
          </div>
        </div>
      </section>

      {/* ─── Service line mix + Regional performance ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Service line mix */}
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            Service Line Mix
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-5">
            Residential vs Commercial share of company revenue · last 30 days
          </p>

          {/* Stacked bar */}
          <div className="flex h-3 w-full rounded-full overflow-hidden mb-5">
            <div
              className="bg-ppp-blue"
              style={{ width: `${serviceLineMix.residential.pct}%` }}
              title={`Residential ${serviceLineMix.residential.pct}%`}
            />
            <div
              className="bg-ppp-orange"
              style={{ width: `${serviceLineMix.commercial.pct}%` }}
              title={`Commercial ${serviceLineMix.commercial.pct}%`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-ppp-blue-100 bg-ppp-blue-50/40 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="h-2 w-2 rounded-full bg-ppp-blue" />
                <span className="text-[11px] font-semibold tracking-wide uppercase text-ppp-blue-700">
                  Residential
                </span>
              </div>
              <div className="text-2xl font-bold text-ppp-charcoal">
                ${serviceLineMix.residential.revenue}K
              </div>
              <div className="mt-1 text-[11px] text-ppp-charcoal-500">
                {serviceLineMix.residential.pct}% of revenue ·{" "}
                {serviceLineMix.residential.reps} reps · avg ticket $
                {serviceLineMix.residential.avgTicket}K
              </div>
            </div>
            <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50/40 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="h-2 w-2 rounded-full bg-ppp-orange" />
                <span className="text-[11px] font-semibold tracking-wide uppercase text-ppp-orange-700">
                  Commercial
                </span>
              </div>
              <div className="text-2xl font-bold text-ppp-charcoal">
                ${serviceLineMix.commercial.revenue}K
              </div>
              <div className="mt-1 text-[11px] text-ppp-charcoal-500">
                {serviceLineMix.commercial.pct}% of revenue ·{" "}
                {serviceLineMix.commercial.reps} reps · avg ticket $
                {serviceLineMix.commercial.avgTicket}K
              </div>
            </div>
          </div>
        </div>

        {/* Regional performance */}
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            Regional Performance
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-5">
            Revenue sold by region · last 30 days
          </p>

          <HorizontalBar
            rows={[...regionalRollup]
              .sort((a, b) => b.revenue - a.revenue)
              .map((r) => ({
                label: r.region,
                value: r.revenue,
                sublabel: `${r.reps} rep${r.reps === 1 ? "" : "s"} · ${r.closeRate.toFixed(1)}% close`,
                colorToken: REGION_COLOR[r.region],
              }))}
            formatValue={(v) => `$${v}K`}
          />
        </div>
      </section>

      {/* ─── Pipeline funnel + Insights ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Funnel */}
        <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            Pipeline Funnel
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-5">
            Movement from lead to closed deal · last 30 days
          </p>

          <div className="space-y-3">
            {pipelineFunnel.map((s, i) => {
              const max = Math.max(...pipelineFunnel.map((x) => x.count));
              const pct = Math.max(8, Math.round((s.count / max) * 100));
              const nextDrop =
                i < pipelineFunnel.length - 1
                  ? Math.round(
                      ((s.count - pipelineFunnel[i + 1].count) / s.count) * 100
                    )
                  : null;
              return (
                <div key={s.stage}>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-sm font-semibold text-ppp-charcoal">
                      {s.stage}
                    </span>
                    <span className="text-sm font-semibold text-ppp-charcoal">
                      {s.count}
                      {s.value > 0 && (
                        <span className="ml-2 text-[11px] text-ppp-charcoal-500">
                          ${s.value}K
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="relative h-7 w-full bg-ppp-charcoal-50 rounded">
                    <div
                      className={`h-full rounded transition-[width] duration-500 ${
                        i === pipelineFunnel.length - 1
                          ? "bg-ppp-green"
                          : i === pipelineFunnel.length - 2
                            ? "bg-ppp-orange"
                            : "bg-ppp-blue"
                      }`}
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
        </div>

        {/* Insights — Top performer + Pipeline at risk */}
        <div className="space-y-4">
          <Link
            href={`/dashboard/rep/${topPerformer.id}`}
            className="block bg-white border border-ppp-charcoal-100 rounded-xl p-5 hover:border-ppp-green-200 hover:shadow-md hover:shadow-ppp-charcoal/5 transition-all"
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-md bg-ppp-green-50 text-ppp-green-700 flex items-center justify-center text-xs font-bold">
                ↑
              </div>
              <h3 className="text-sm font-semibold text-ppp-charcoal">
                Top Performer
              </h3>
            </div>
            <div className="font-semibold text-ppp-charcoal">
              {topPerformer.name}
            </div>
            <div className="text-xs text-ppp-charcoal-500 mt-0.5">
              {topPerformer.region}
            </div>
            <div className="mt-3 flex items-baseline gap-3">
              <div className="text-2xl font-bold text-ppp-green-700">
                ${topPerformer.revenue}K
              </div>
              <div className="text-xs text-ppp-charcoal-500">
                {topPerformer.closeRate}% close
              </div>
            </div>
            <div className="mt-3 text-[11px] font-medium text-ppp-blue">
              View deep-dive →
            </div>
          </Link>

          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-6 w-6 rounded-md bg-ppp-orange-50 text-ppp-orange-700 flex items-center justify-center text-xs font-bold">
                !
              </div>
              <h3 className="text-sm font-semibold text-ppp-charcoal">
                Pipeline at Risk
              </h3>
            </div>
            <div className="text-2xl font-bold text-ppp-orange">
              ${pipelineAtRisk.value}K
            </div>
            <div className="text-xs text-ppp-charcoal-500 mt-0.5">
              {pipelineAtRisk.count} deals · {pipelineAtRisk.reps} reps · {">"}14 days in stage
            </div>
            <button className="mt-3 text-xs font-medium text-ppp-blue hover:text-ppp-blue-700">
              Review stuck deals →
            </button>
          </div>
        </div>
      </section>

      {/* ─── Rep leaderboard ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">
                Rep Leaderboard
              </h3>
              <p className="text-xs text-ppp-charcoal-500 mt-0.5">
                Sorted by revenue sold · click any row for the rep deep-dive
              </p>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-ppp-charcoal">
                ${teamTotals.revenueSold}K
              </div>
              <div className="text-[11px] text-ppp-charcoal-500">team total</div>
            </div>
          </div>

          <table className="w-full">
            <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
              <tr>
                <th className="text-left px-6 py-3">Rep</th>
                <th className="text-left px-6 py-3">Region</th>
                <th className="text-left px-6 py-3">Service Line</th>
                <th className="text-right px-6 py-3">Revenue</th>
                <th className="text-right px-6 py-3">Close Rate</th>
                <th className="text-right px-6 py-3">Avg Ticket</th>
                <th className="text-right px-6 py-3">Open Pipeline</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="text-sm">
              {[...reps]
                .sort((a, b) => b.revenueSold - a.revenueSold)
                .map((r, i) => (
                  <tr
                    key={r.id}
                    className="group border-t border-ppp-charcoal-100 hover:bg-ppp-blue-50/40 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <Link
                        href={`/dashboard/rep/${r.id}`}
                        className="flex items-center gap-3"
                      >
                        <div className="h-8 w-8 rounded-full bg-ppp-blue-50 text-ppp-blue text-xs font-bold flex items-center justify-center">
                          {r.name.split(" ").map((n) => n[0]).join("")}
                        </div>
                        <div>
                          <div className="font-semibold text-ppp-charcoal group-hover:text-ppp-blue transition-colors">
                            {r.name}
                          </div>
                          <div className="text-[11px] text-ppp-charcoal-500">
                            #{i + 1} this period
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-ppp-charcoal-500">{r.region}</td>
                    <td className="px-6 py-4">
                      <span
                        className={[
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                          r.serviceLine === "Commercial"
                            ? "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100"
                            : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
                        ].join(" ")}
                      >
                        {r.serviceLine}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-ppp-charcoal">
                      ${r.revenueSold}K
                    </td>
                    <td className="px-6 py-4 text-right text-ppp-charcoal">
                      {r.closeRate.toFixed(1)}%
                    </td>
                    <td className="px-6 py-4 text-right text-ppp-charcoal">
                      ${r.avgTicket.toFixed(1)}K
                    </td>
                    <td className="px-6 py-4 text-right text-ppp-charcoal-500">
                      ${r.openPipeline}K
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/dashboard/rep/${r.id}`}
                        className="text-xs font-medium text-ppp-blue opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
