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

  // 6-month vs prior 6-month revenue trend summary
  const last6 = monthly.slice(-6).reduce((s, m) => s + m.revenue, 0);
  const prior6 = monthly.slice(0, 6).reduce((s, m) => s + m.revenue, 0);
  const halfDelta = prior6 === 0 ? 0 : Math.round(((last6 - prior6) / prior6) * 100);

  return (
    <div className="space-y-10">
      {/* ─── Back link + rep header ─── */}
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ppp-charcoal-500 hover:text-ppp-blue transition-colors mb-5"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Back to Company Overview
        </Link>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6 flex items-center justify-between gap-6">
          <div className="flex items-center gap-5">
            <div className="h-16 w-16 rounded-full bg-ppp-blue-50 text-ppp-blue text-xl font-bold flex items-center justify-center">
              {rep.name.split(" ").map((n) => n[0]).join("")}
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal">
                {rep.name}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
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
                <span className="text-ppp-charcoal-500">
                  {tenure(rep.startedAt)} at PPP
                </span>
              </div>
            </div>
          </div>

          <div className="hidden sm:block text-right">
            <div className="text-[11px] uppercase tracking-wide text-ppp-charcoal-500">
              Trailing 12-month revenue
            </div>
            <div className="text-2xl font-bold text-ppp-charcoal mt-1">
              ${monthly.reduce((s, m) => s + m.revenue, 0).toLocaleString()}K
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

      {/* ─── KPI row (rep vs team avg) ─── */}
      <section>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            label="Revenue Sold"
            value={`$${rep.revenueSold}K`}
            change={dRev.text}
            trend={dRev.trend}
            accent="blue"
          />
          <KPICard
            label="Close Rate"
            value={`${rep.closeRate.toFixed(1)}%`}
            change={dClose.text}
            trend={dClose.trend}
            accent="green"
          />
          <KPICard
            label="Avg Ticket"
            value={`$${rep.avgTicket.toFixed(1)}K`}
            change={dTicket.text}
            trend={dTicket.trend}
            accent="orange"
          />
          <KPICard
            label="Open Pipeline"
            value={`$${rep.openPipeline}K`}
            change={dPipe.text}
            trend={dPipe.trend}
            accent="blue"
          />
        </div>
      </section>

      {/* ─── 12-month revenue trend ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h3 className="text-base font-semibold text-ppp-charcoal">
                Revenue · Last 12 Months
              </h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                {rep.name.split(" ")[0]}&apos;s monthly revenue sold. Most recent month on the right.
              </p>
            </div>
          </div>
          <div className="mt-5">
            <TrendChart
              data={monthly.map((m) => ({ label: m.month, value: m.revenue }))}
              colorToken="ppp-blue"
              yFormat="currency-k"
              height={240}
            />
          </div>
        </div>
      </section>

      {/* ─── Close rate + Avg ticket trends ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            Close Rate · 12-Month Trend
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            % of quotes that converted to a sold deal
          </p>
          <TrendChart
            data={monthly.map((m) => ({ label: m.month, value: m.closeRate }))}
            colorToken="ppp-green"
            yFormat="percent"
            height={180}
          />
        </div>

        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal">
            Avg Ticket · 12-Month Trend
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
            Average deal size on closed-won work
          </p>
          <TrendChart
            data={monthly.map((m) => ({ label: m.month, value: m.avgTicket }))}
            colorToken="ppp-orange"
            yFormat="currency-k"
            height={180}
          />
        </div>
      </section>

      {/* ─── Activity stats ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal mb-1">
            Activity · Last 30 Days
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mb-5">
            Volume and velocity behind the headline numbers
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ActivityStat label="Appointments held" value={rep.appointmentsHeld} />
            <ActivityStat label="Quotes sent" value={rep.quotesSent} />
            <ActivityStat
              label="Avg days to close"
              value={rep.daysAvgClose}
              suffix=" days"
            />
            <ActivityStat
              label="Quote → Close"
              value={Math.round((rep.closeRate / 100) * rep.quotesSent)}
              hint={`of ${rep.quotesSent} quotes sent`}
            />
          </div>
        </div>
      </section>

      {/* ─── Recent deals ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-ppp-charcoal-100">
            <h3 className="text-base font-semibold text-ppp-charcoal">
              Recent Deals
            </h3>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              Last 8 deals across all stages
            </p>
          </div>
          <table className="w-full">
            <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
              <tr>
                <th className="text-left px-6 py-3">Customer</th>
                <th className="text-left px-6 py-3">Stage</th>
                <th className="text-right px-6 py-3">Amount</th>
                <th className="text-right px-6 py-3">Closed / Days in stage</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {recentDeals.map((d) => (
                <tr key={d.id} className="border-t border-ppp-charcoal-100">
                  <td className="px-6 py-4 font-medium text-ppp-charcoal">
                    {d.customer}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={[
                        "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                        STAGE_STYLES[d.stage] ?? STAGE_STYLES["Quoted"],
                      ].join(" ")}
                    >
                      {d.stage}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right font-semibold text-ppp-charcoal">
                    ${d.amount}K
                  </td>
                  <td className="px-6 py-4 text-right text-ppp-charcoal-500">
                    {d.closedAt ? d.closedAt : `${d.daysInStage}d in stage`}
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
    <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50/50 p-4">
      <div className="text-[11px] uppercase tracking-wide text-ppp-charcoal-500">
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-bold text-ppp-charcoal">
        {value}
        {suffix}
      </div>
      {hint && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{hint}</div>}
    </div>
  );
}
