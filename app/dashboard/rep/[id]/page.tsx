import Link from "next/link";
import { notFound } from "next/navigation";
import KPICard from "@/components/kpi-card";
import TrendChart from "@/components/trend-chart";
import {
  reps,
  teamTotals,
  getRepMonthly,
  getRepRecentDeals,
  type Rep,
} from "@/lib/mock-data";

export function generateStaticParams() {
  return reps.map((r) => ({ id: r.id }));
}

function tenure(startedAt: string) {
  const start = new Date(startedAt);
  const now = new Date("2026-05-19");
  const months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months} mo`;
  if (rem === 0) return `${years} yr${years > 1 ? "s" : ""}`;
  return `${years}y ${rem}m`;
}

function deltaVsTeam(repValue: number, teamValue: number) {
  const diff = repValue - teamValue;
  const pct = teamValue === 0 ? 0 : Math.round((diff / teamValue) * 100);
  return {
    pct,
    trend: pct > 1 ? "up" : pct < -1 ? "down" : "flat",
    text: `${pct > 0 ? "+" : ""}${pct}% vs team avg`,
  } as const;
}

const STAGE_STYLES: Record<string, string> = {
  "Closed Won": "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100",
  "Closed Lost": "text-ppp-charcoal bg-ppp-charcoal-50 border-ppp-charcoal-100",
  Quoted: "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
  Appointment: "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100",
};

export default async function RepDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rep: Rep | undefined = reps.find((r) => r.id === id);
  if (!rep) notFound();

  const monthly = getRepMonthly(rep.id);
  const recentDeals = getRepRecentDeals(rep.id);

  const teamAvgRevenue = teamTotals.revenueSold / reps.length;
  const teamAvgCloseRate = teamTotals.closeRate;
  const teamAvgTicket = teamTotals.avgTicket;
  const teamAvgPipeline = reps.reduce((s, r) => s + r.openPipeline, 0) / reps.length;

  const dRev = deltaVsTeam(rep.revenueSold, teamAvgRevenue);
  const dClose = deltaVsTeam(rep.closeRate, teamAvgCloseRate);
  const dTicket = deltaVsTeam(rep.avgTicket, teamAvgTicket);
  const dPipe = deltaVsTeam(rep.openPipeline, teamAvgPipeline);

  const last6 = monthly.slice(-6).reduce((s, m) => s + m.revenue, 0);
  const prior6 = monthly.slice(0, 6).reduce((s, m) => s + m.revenue, 0);
  const halfDelta = prior6 === 0 ? 0 : Math.round(((last6 - prior6) / prior6) * 100);
  const ttmRevenue = monthly.reduce((s, m) => s + m.revenue, 0);

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-up">
      {/* ─── Back link + rep header ─── */}
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-charcoal-500 hover:text-ppp-blue transition-colors mb-4 sm:mb-5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Back to Company Overview
        </Link>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-6">
          <div className="flex items-center gap-4 sm:gap-5 min-w-0">
            <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-full bg-ppp-blue-50 text-ppp-blue text-lg sm:text-xl font-bold flex items-center justify-center shrink-0">
              {rep.name.split(" ").map((n) => n[0]).join("")}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ppp-charcoal truncate">
                {rep.name}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs">
                <span className="text-ppp-charcoal-500">{rep.region}</span>
                <span className="text-ppp-charcoal-200">·</span>
                <span
                  className={[
                    "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                    rep.serviceLine === "Commercial"
                      ? "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100"
                      : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
                  ].join(" ")}
                >
                  {rep.serviceLine}
                </span>
                <span className="text-ppp-charcoal-200">·</span>
                <span className="text-ppp-charcoal-500">{tenure(rep.startedAt)} at PPP</span>
              </div>
            </div>
          </div>

          <div className="sm:text-right pt-3 sm:pt-0 border-t sm:border-t-0 border-ppp-charcoal-100 sm:border-none">
            <div className="font-condensed text-[10px] sm:text-[11px] uppercase tracking-wide text-ppp-charcoal-500">
              Trailing 12-month revenue
            </div>
            <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
              ${ttmRevenue.toLocaleString()}K
            </div>
            <div
              className={[
                "mt-1 text-[11px] font-semibold",
                halfDelta > 0 ? "text-ppp-green-700" : halfDelta < 0 ? "text-ppp-orange-700" : "text-ppp-charcoal-500",
              ].join(" ")}
            >
              {halfDelta > 0 ? "+" : ""}{halfDelta}% last 6mo vs prior 6mo
            </div>
          </div>
        </div>
      </div>

      {/* ─── KPI row ─── */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KPICard label="Revenue Sold" value={`$${rep.revenueSold}K`} change={dRev.text} trend={dRev.trend} accent="blue" />
          <KPICard label="Close Rate" value={`${rep.closeRate.toFixed(1)}%`} change={dClose.text} trend={dClose.trend} accent="green" />
          <KPICard label="Avg Ticket" value={`$${rep.avgTicket.toFixed(1)}K`} change={dTicket.text} trend={dTicket.trend} accent="orange" />
          <KPICard label="Open Pipeline" value={`$${rep.openPipeline}K`} change={dPipe.text} trend={dPipe.trend} accent="blue" />
        </div>
      </section>

      {/* ─── 12-month revenue trend ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Revenue · Last 12 Months</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            {rep.name.split(" ")[0]}&apos;s monthly revenue sold. Hover or tap a point for the exact value.
          </p>
          <div className="mt-5">
            <TrendChart
              data={monthly.map((m) => ({ label: m.month, value: m.revenue }))}
              colorToken="ppp-blue"
              yFormat="currency-k"
              heightClassName="h-[200px] sm:h-[240px]"
            />
          </div>
        </div>
      </section>

      {/* ─── Close rate + Avg ticket ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Close Rate · 12-Month Trend</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            % of quotes that converted to a sold deal
          </p>
          <TrendChart
            data={monthly.map((m) => ({ label: m.month, value: m.closeRate }))}
            colorToken="ppp-green"
            yFormat="percent"
            heightClassName="h-[160px] sm:h-[180px]"
          />
        </div>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">Avg Ticket · 12-Month Trend</h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            Average deal size on closed-won work
          </p>
          <TrendChart
            data={monthly.map((m) => ({ label: m.month, value: m.avgTicket }))}
            colorToken="ppp-orange"
            yFormat="currency-k"
            heightClassName="h-[160px] sm:h-[180px]"
          />
        </div>
      </section>

      {/* ─── Activity stats ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal mb-1">Activity · Last 30 Days</h3>
          <p className="text-xs text-ppp-charcoal-500 mb-5">Volume and velocity behind the headline numbers</p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <ActivityStat label="Appointments held" value={rep.appointmentsHeld} />
            <ActivityStat label="Quotes sent" value={rep.quotesSent} />
            <ActivityStat label="Avg days to close" value={rep.daysAvgClose} suffix=" days" />
            <ActivityStat
              label="Quote → Close"
              value={Math.round((rep.closeRate / 100) * rep.quotesSent)}
              hint={`of ${rep.quotesSent} quotes`}
            />
          </div>
        </div>
      </section>

      {/* ─── Recent deals ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100">
            <h3 className="text-base font-semibold text-ppp-charcoal">Recent Deals</h3>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">Last 8 deals across all stages</p>
          </div>

          {/* Desktop / tablet: table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                <tr>
                  <th className="text-left px-6 py-3">Customer</th>
                  <th className="text-left px-6 py-3">Stage</th>
                  <th className="text-right px-6 py-3">Amount</th>
                  <th className="text-right px-6 py-3">Closed / Age</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {recentDeals.map((d) => (
                  <tr key={d.id} className="border-t border-ppp-charcoal-100">
                    <td className="px-6 py-3.5 font-medium text-ppp-charcoal">{d.customer}</td>
                    <td className="px-6 py-3.5">
                      <span
                        className={[
                          "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                          STAGE_STYLES[d.stage] ?? STAGE_STYLES["Quoted"],
                        ].join(" ")}
                      >
                        {d.stage}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-right font-semibold text-ppp-charcoal">${d.amount}K</td>
                    <td className="px-6 py-3.5 text-right text-ppp-charcoal-500">
                      {d.closedAt ? d.closedAt : `${d.daysInStage}d in stage`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: card list */}
          <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
            {recentDeals.map((d) => (
              <li key={d.id} className="px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-ppp-charcoal truncate">{d.customer}</div>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                      {d.closedAt ? d.closedAt : `${d.daysInStage}d in stage`}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold text-ppp-charcoal">${d.amount}K</div>
                    <span
                      className={[
                        "inline-flex items-center px-1.5 py-0 mt-1 rounded text-[10px] font-medium border",
                        STAGE_STYLES[d.stage] ?? STAGE_STYLES["Quoted"],
                      ].join(" ")}
                    >
                      {d.stage}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function ActivityStat({
  label,
  value,
  suffix = "",
  hint,
}: {
  label: string;
  value: number;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 p-3 sm:p-4">
      <div className="font-condensed text-[10px] sm:text-[11px] uppercase tracking-wide text-ppp-charcoal-500">
        {label}
      </div>
      <div className="font-condensed mt-1.5 text-xl sm:text-2xl font-bold text-ppp-navy">
        {value}
        {suffix}
      </div>
      {hint && <div className="text-[10px] sm:text-[11px] text-ppp-charcoal-500 mt-0.5">{hint}</div>}
    </div>
  );
}
