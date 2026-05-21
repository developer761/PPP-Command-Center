import Link from "next/link";
import { notFound } from "next/navigation";
import KPICard from "@/components/kpi-card";
import TrendChart from "@/components/trend-chart";
import {
  reps as mockReps,
  getRepMonthly as getMockRepMonthly,
  getRepRecentDeals as getMockRepRecentDeals,
  type Rep,
} from "@/lib/mock-data";
import {
  loadDashboardData,
  getRepMonthlyFor,
  getRepRecentDealsFor,
} from "@/lib/data-source";
import { deriveRepsForPeriod, deriveRepAccountStats } from "@/lib/salesforce/derive";
import type { SnapshotAccount } from "@/lib/salesforce/queries";
import { fmtMoneyK } from "@/lib/format";

export function generateStaticParams() {
  // Pre-build mock rep routes; SF rep routes render on-demand.
  return mockReps.map((r) => ({ id: r.id }));
}

// Force dynamic rendering so SF-fetched reps work alongside the prebuilt mock IDs.
export const dynamic = "force-dynamic";

function tenure(startedAt: string | null) {
  if (!startedAt) return "—";
  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return "—";
  const now = new Date();
  const months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  if (months <= 0) return "<1 mo";
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

  // Pull the full snapshot bundle so we can derive everything from one fetch.
  const bundle = await loadDashboardData();
  // Use lifetime for the rep deep-dive so totals/region inference cover the full snapshot.
  const reps: Rep[] = bundle.snapshot
    ? deriveRepsForPeriod(bundle.snapshot, "lifetime")
    : mockReps;
  const rep: Rep | undefined = reps.find((r) => r.id === id);
  if (!rep) notFound();

  // Per-rep monthly history + recent deals — live from snapshot when available.
  const monthly =
    getRepMonthlyFor(bundle, rep.id) ?? getMockRepMonthly(rep.id);
  const recentDeals =
    getRepRecentDealsFor(bundle, rep.id) ?? getMockRepRecentDeals(rep.id);
  const hasActivity = monthly.some((m) => m.revenue > 0) || recentDeals.length > 0;
  const noHistoricalData = !hasActivity;

  // Account stats — only when on live data. Repeat-customer counts,
  // lifetime revenue across their accounts, BM-retailer flags, top account.
  const accountStats = bundle.snapshot
    ? deriveRepAccountStats(bundle.snapshot, rep.id)
    : null;

  // Indexed account lookup so the recent-deals table can flag Repeat Customer
  // accounts inline.
  const accountByName = bundle.snapshot
    ? new Map(bundle.snapshot.accounts.map((a) => [a.name, a]))
    : new Map();

  // Lead Group breakdown — where their accounts came from (Angi Ads, Referral, etc.)
  const leadGroupCounts = new Map<string, number>();
  let maxRecentDate: Date | null = null;
  if (bundle.snapshot) {
    const seenAccountIds = new Set<string>();
    for (const w of bundle.snapshot.workOrders) {
      if (w.ownerId !== rep.id) continue;
      // Track most recent activity for "Last Activity" timestamp
      const dStr = w.closeDate ?? w.createdDate;
      if (dStr) {
        const d = new Date(dStr);
        if (!isNaN(d.getTime()) && (!maxRecentDate || d > maxRecentDate)) maxRecentDate = d;
      }
      if (!w.accountName) continue;
      const acct = accountByName.get(w.accountName);
      if (!acct || seenAccountIds.has(acct.id)) continue;
      seenAccountIds.add(acct.id);
      const group = acct.leadGroup ?? "Unknown";
      leadGroupCounts.set(group, (leadGroupCounts.get(group) ?? 0) + 1);
    }
  }
  const leadGroupList = Array.from(leadGroupCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const daysSinceLast = maxRecentDate
    ? Math.floor((Date.now() - maxRecentDate.getTime()) / 86_400_000)
    : null;

  // Team averages computed from the actual loaded reps (not module-level mock).
  const teamRevenue = reps.reduce((s, r) => s + r.revenueSold, 0);
  const totalQuotes = reps.reduce((s, r) => s + r.quotesSent, 0);
  const totalAppts = reps.reduce((s, r) => s + r.appointmentsHeld, 0);
  const teamAvgRevenue = teamRevenue / Math.max(1, reps.length);
  const teamAvgCloseRate =
    totalQuotes > 0
      ? reps.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) / totalQuotes
      : 0;
  const teamAvgTicket =
    totalAppts > 0
      ? reps.reduce((s, r) => s + r.avgTicket * r.appointmentsHeld, 0) / totalAppts
      : 0;
  const teamAvgPipeline = reps.reduce((s, r) => s + r.openPipeline, 0) / Math.max(1, reps.length);

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
                {daysSinceLast !== null && (
                  <>
                    <span className="text-ppp-charcoal-200">·</span>
                    <span
                      className={[
                        "inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium",
                        daysSinceLast <= 7
                          ? "text-ppp-green-700 bg-ppp-green-50"
                          : daysSinceLast <= 30
                          ? "text-ppp-charcoal-500 bg-ppp-charcoal-50"
                          : "text-ppp-orange-700 bg-ppp-orange-50",
                      ].join(" ")}
                    >
                      Last activity {daysSinceLast === 0 ? "today" : `${daysSinceLast}d ago`}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="sm:text-right pt-3 sm:pt-0 border-t sm:border-t-0 border-ppp-charcoal-100 sm:border-none">
            <div className="font-condensed text-[10px] sm:text-[11px] uppercase tracking-wide text-ppp-charcoal-500">
              Trailing 12-month revenue
            </div>
            <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy mt-1">
              {fmtMoneyK(ttmRevenue)}
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
          <KPICard label="Revenue Sold" value={fmtMoneyK(rep.revenueSold)} change={dRev.text} trend={dRev.trend} accent="blue" />
          <KPICard label="Close Rate" value={`${rep.closeRate.toFixed(1)}%`} change={dClose.text} trend={dClose.trend} accent="green" />
          <KPICard label="Avg Ticket" value={fmtMoneyK(rep.avgTicket)} change={dTicket.text} trend={dTicket.trend} accent="orange" />
          <KPICard label="Open Pipeline" value={fmtMoneyK(rep.openPipeline)} change={dPipe.text} trend={dPipe.trend} accent="blue" />
        </div>
      </section>

      {/* ─── Account stats card + Lead Group breakdown ─── */}
      {accountStats && accountStats.totalCustomers > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
          {/* Customer mix */}
          <div className="lg:col-span-2 bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-semibold text-ppp-charcoal">Customer Mix</h3>
                <p className="text-xs text-ppp-charcoal-500 mt-1">
                  Accounts {rep.name.split(" ")[0]} owns deals with
                </p>
              </div>
              <div className="font-condensed text-2xl font-bold text-ppp-navy">
                {accountStats.totalCustomers}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat
                label="New"
                value={accountStats.newCustomers.toString()}
                sub="customers"
                accent="blue"
              />
              <Stat
                label="Repeat"
                value={accountStats.repeatCustomers.toString()}
                sub={accountStats.totalCustomers > 0
                  ? `${Math.round((accountStats.repeatCustomers / accountStats.totalCustomers) * 100)}% repeat`
                  : "—"}
                accent={accountStats.repeatCustomers > 0 ? "green" : "muted"}
              />
              <Stat
                label="Lifetime Rev"
                value={fmtMoneyK(accountStats.totalLifetimeRevenue / 1000)}
                sub="across all WOs"
              />
              <Stat
                label="BM Retailers"
                value={accountStats.bmRetailerCount.toString()}
                sub="Benjamin Moore"
                accent={accountStats.bmRetailerCount > 0 ? "orange" : "muted"}
              />
            </div>
            {accountStats.topAccountName && (
              <div className="mt-4 pt-3 border-t border-ppp-charcoal-100 flex items-baseline justify-between gap-3 text-xs">
                <span className="text-ppp-charcoal-500">Top account by {rep.name.split(" ")[0]}&apos;s revenue</span>
                <span className="font-medium text-ppp-charcoal truncate">
                  {accountStats.topAccountName} · {fmtMoneyK(accountStats.topAccountRevenue / 1000)}
                </span>
              </div>
            )}
          </div>

          {/* Lead Group breakdown */}
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
            <h3 className="text-base font-semibold text-ppp-charcoal">Lead Sources</h3>
            <p className="text-xs text-ppp-charcoal-500 mt-1 mb-4">
              How {rep.name.split(" ")[0]}&apos;s customers were sourced
            </p>
            {leadGroupList.length > 0 ? (
              <ul className="space-y-2">
                {leadGroupList.map(([group, count]) => {
                  const pct = Math.round((count / accountStats.totalCustomers) * 100);
                  return (
                    <li key={group}>
                      <div className="flex items-baseline justify-between text-[11px] mb-0.5">
                        <span className="text-ppp-charcoal font-medium truncate pr-2">{group}</span>
                        <span className="text-ppp-charcoal-500 shrink-0">
                          {count} · {pct}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-ppp-charcoal-50 rounded">
                        <div
                          className="h-full bg-ppp-blue rounded transition-[width] duration-500"
                          style={{ width: `${Math.max(4, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-ppp-charcoal-500 italic">
                No lead source data on these accounts yet.
              </p>
            )}
          </div>
        </section>
      )}

      {noHistoricalData && (
        <div className="rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 text-ppp-charcoal-500 text-xs sm:text-sm px-4 py-3">
          <strong>No closed-won activity in the last 12 months.</strong> {rep.name.split(" ")[0]} doesn&apos;t have any deals to chart yet. The charts below will populate as their pipeline progresses.
        </div>
      )}

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
                    <td className="px-6 py-3.5 font-medium text-ppp-charcoal">
                      <span className="inline-flex items-center gap-1.5">
                        {d.customer}
                        <CustomerBadges acct={accountByName.get(d.customer)} />
                      </span>
                    </td>
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
                    <td className="px-6 py-3.5 text-right font-semibold text-ppp-charcoal">{fmtMoneyK(d.amount)}</td>
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
                    <div className="font-medium text-ppp-charcoal truncate">
                      {d.customer}
                      <CustomerBadges acct={accountByName.get(d.customer)} />
                    </div>
                    <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                      {d.closedAt ? d.closedAt : `${d.daysInStage}d in stage`}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-semibold text-ppp-charcoal">{fmtMoneyK(d.amount)}</div>
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

function CustomerBadges({ acct }: { acct?: SnapshotAccount }) {
  if (!acct) return null;
  const badges: { label: string; cls: string; title?: string }[] = [];
  if ((acct.type ?? "").toLowerCase().includes("repeat")) {
    badges.push({
      label: "Repeat",
      cls: "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100",
      title: "Repeat Customer — has done business with PPP before",
    });
  }
  if (acct.isKeyRelationship) {
    badges.push({
      label: "Key",
      cls: "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
      title: "Key Relationship — flagged as strategic account in Salesforce",
    });
  }
  if (acct.isBMRetailer) {
    badges.push({
      label: "BM",
      cls: "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100",
      title: "Benjamin Moore Retailer",
    });
  }
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 ml-1.5 align-middle">
      {badges.map((b) => (
        <span
          key={b.label}
          title={b.title}
          className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold border ${b.cls}`}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "blue" | "green" | "orange" | "muted";
}) {
  const accentClass =
    accent === "blue" ? "text-ppp-blue-700" :
    accent === "green" ? "text-ppp-green-700" :
    accent === "orange" ? "text-ppp-orange-700" :
    accent === "muted" ? "text-ppp-charcoal-200" :
    "text-ppp-navy";
  return (
    <div>
      <div className="font-condensed text-[10px] uppercase tracking-wide text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-bold ${accentClass} mt-0.5`}>{value}</div>
      {sub && <div className="text-[10px] text-ppp-charcoal-500 mt-0.5 truncate">{sub}</div>}
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
