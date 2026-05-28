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
  getRepUpcomingWorkFor,
} from "@/lib/data-source";
import { deriveRepsForPeriod, deriveRepAccountStats } from "@/lib/salesforce/derive";
import { deriveRepScorecard, type RepScorecard } from "@/lib/salesforce/rep-scorecard";
import { currentFY, currentFiscalQuarter, priorFiscalQuarter, fyLabel } from "@/lib/fiscal-year";
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
  // No team baseline (every field rep is $0/0% on this metric) — a "+0%" here
  // would read as "exactly average" when it really means "nothing to compare."
  if (teamValue === 0) {
    return { pct: 0, trend: "flat", text: "no team baseline" } as const;
  }
  const diff = repValue - teamValue;
  const pct = Math.round((diff / teamValue) * 100);
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);

  // Pull the full snapshot bundle so we can derive everything from one fetch.
  const bundle = await loadDashboardData(sp);

  // Worker-scope guard (DEFENSE-IN-DEPTH).
  //
  // Without this guard a worker navigating directly to /dashboard/rep/{other-id}
  // would hit the page; the snapshot scoping would then filter them down to
  // 0 matching reps and the find() below would return undefined → 404. THAT
  // path technically works, but relies on snapshot scoping being intact —
  // any future regression in scope-snapshot.ts could leak another rep's
  // entire profile (revenue, deals, customer mix, account stats).
  //
  // Explicit check here: if viewer is scoped="my" and the URL id doesn't
  // match their effective user, render 404 IMMEDIATELY before any data
  // derivation happens. Admins (scope="all") fall through to the normal
  // path and can view any rep.
  if (
    bundle.viewer &&
    bundle.viewer.scope === "my" &&
    bundle.viewer.effectiveUserId &&
    bundle.viewer.effectiveUserId !== id
  ) {
    notFound();
  }

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
  const upcomingWork = getRepUpcomingWorkFor(bundle, rep.id) ?? [];
  const hasActivity =
    monthly.some((m) => m.revenue > 0) || recentDeals.length > 0 || upcomingWork.length > 0;
  const noHistoricalData = !hasActivity;

  // Account stats — only when on live data. Repeat-customer counts,
  // lifetime revenue across their accounts, BM-retailer flags, top account.
  const accountStats = bundle.snapshot
    ? deriveRepAccountStats(bundle.snapshot, rep.id)
    : null;

  // KPI scorecard anchored on the PRIOR (just-completed) fiscal quarter — the
  // FPRC report cards report PFQ, not the in-progress quarter, so a mid-quarter
  // partial would NOT reconcile against FPRC_*. (A period picker defaulting to
  // PFQ would be the natural enhancement.)
  // Skipped on mock data (no quotas/transactions/reviews to derive from).
  const { fy: scFy, q: scQ } = priorFiscalQuarter(currentFY(), currentFiscalQuarter());
  const scorecard: RepScorecard | null = bundle.snapshot
    ? deriveRepScorecard(bundle.snapshot, rep.id, { fy: scFy, q: scQ })
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
    const nowMs = Date.now();
    for (const w of bundle.snapshot.workOrders) {
      if (w.ownerId !== rep.id) continue;
      // Track most recent activity. Bug fix: PPP's CloseDate is often a
      // PROJECTED close in the future. Ignore future-dated entries so the
      // "Last activity" badge doesn't show a misleading green "today" for
      // a deal that hasn't actually happened yet. Use createdDate which is
      // always real, and prefer closeDate only if it's in the past.
      const closeMs = w.closeDate ? new Date(w.closeDate).getTime() : NaN;
      const createdMs = new Date(w.createdDate).getTime();
      const candidate = !isNaN(closeMs) && closeMs <= nowMs ? closeMs : createdMs;
      if (!isNaN(candidate)) {
        const d = new Date(candidate);
        if (!maxRecentDate || d > maxRecentDate) maxRecentDate = d;
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

  // Team averages — restrict to PPP's canonical rep universe (Profile ending
  // "Standard.Field") so admins/office staff don't dilute the peer group. This
  // matches the set the scorecard's rank gates on (FPRC §B). Mock reps have
  // isFieldStandard=undefined → treated as field. Ratios are weighted
  // (Σnumerator ÷ Σdenominator), never mean-of-means.
  const fieldReps = reps.filter((r) => r.isFieldStandard !== false);
  const teamRevenue = fieldReps.reduce((s, r) => s + r.revenueSold, 0);
  const totalQuotes = fieldReps.reduce((s, r) => s + r.quotesSent, 0);
  const totalAppts = fieldReps.reduce((s, r) => s + r.appointmentsHeld, 0);
  const teamAvgRevenue = teamRevenue / Math.max(1, fieldReps.length);
  const teamAvgCloseRate =
    totalQuotes > 0
      ? fieldReps.reduce((s, r) => s + r.closeRate * r.quotesSent, 0) / totalQuotes
      : 0;
  const teamAvgTicket =
    totalAppts > 0
      ? fieldReps.reduce((s, r) => s + r.avgTicket * r.appointmentsHeld, 0) / totalAppts
      : 0;
  const teamAvgPipeline = fieldReps.reduce((s, r) => s + r.openPipeline, 0) / Math.max(1, fieldReps.length);

  // When the snapshot is scoped to a single rep (rep signed in, or admin
  // viewing-as), the "team" is just this one rep — every delta computes to
  // 0%. Replace with a "—" / context label instead of a misleading "+0%".
  const teamHasMultipleReps = fieldReps.length > 1;
  const dRev = teamHasMultipleReps
    ? deltaVsTeam(rep.revenueSold, teamAvgRevenue)
    : ({ pct: 0, trend: "flat", text: "Your data" } as const);
  const dClose = teamHasMultipleReps
    ? deltaVsTeam(rep.closeRate, teamAvgCloseRate)
    : ({ pct: 0, trend: "flat", text: "Your data" } as const);
  const dTicket = teamHasMultipleReps
    ? deltaVsTeam(rep.avgTicket, teamAvgTicket)
    : ({ pct: 0, trend: "flat", text: "Your data" } as const);
  const dPipe = teamHasMultipleReps
    ? deltaVsTeam(rep.openPipeline, teamAvgPipeline)
    : ({ pct: 0, trend: "flat", text: "Your data" } as const);

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
            <div
              className="font-condensed text-[10px] sm:text-[11px] uppercase tracking-wide text-ppp-charcoal-500"
              title="Revenue closed in the last 12 months from deals created in the same window. Short-cycle only — see the Scorecard below for PPP fiscal-period KPIs."
            >
              Revenue · Last 12 months
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

      {/* ─── KPI row ─── Headline summary, last 12 months by Opp create
          date. Period is intentionally different from the Scorecard below
          (which is fiscal-quarter scoped per PPP's FPRC reports). The
          label above + tooltips on each card make this explicit so the
          rep doesn't wonder why "Revenue Sold" and "% to Goal" disagree. */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3 sm:mb-4">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-ppp-charcoal tracking-tight">
              Headline KPIs
            </h3>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              Last 12 months · trailing window
            </p>
          </div>
          <span className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-50 px-2 py-0.5 rounded">
            12-month
          </span>
        </div>
        <div
          className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
          title="Headline 12-month view. For the canonical PPP fiscal-period KPIs, see the Scorecard section below."
        >
          <KPICard label="Revenue Sold" value={fmtMoneyK(rep.revenueSold)} change={dRev.text} trend={dRev.trend} accent="blue" />
          <KPICard
            label="Conversion Rate"
            value={`${rep.closeRate.toFixed(1)}%`}
            change={dClose.text}
            trend={dClose.trend}
            accent="green"
          />
          <KPICard label="Avg Ticket" value={fmtMoneyK(rep.avgTicket)} change={dTicket.text} trend={dTicket.trend} accent="orange" />
          <KPICard label="Open Pipeline" value={fmtMoneyK(rep.openPipeline)} change={dPipe.text} trend={dPipe.trend} accent="blue" />
        </div>
        <p className="mt-2 text-[11px] text-ppp-charcoal-500 italic px-1">
          <strong>Conversion Rate</strong> = opps that became a real paid job ÷ opps created. Excludes Estimate / Appointment WOs and cancelled / dead deals. See <strong>Scorecard · Close Rate</strong> below for PPP&apos;s canonical KPI 3 metric (IsWon-based, fiscal-period).
        </p>
      </section>

      {/* ─── PPP Scorecard · Prior Fiscal Quarter ───
          KPIs 1-9 from PPP's REP_PERFORMANCE_KPIS spec, mirroring the FPRC
          report cards. Anchored on the PRIOR (just-completed) fiscal quarter
          since FPRC reports PFQ — a mid-quarter partial wouldn't reconcile.
          PPP FY = Feb 1 → Jan 31. Each card null-safe — a rep without a
          quota row, attendance data, or transaction history renders an
          explicit "no data" rather than misleading $0/0%. */}
      {scorecard && (
        <section>
          <div className="flex items-end justify-between gap-3 mb-4 sm:mb-5">
            <div>
              <h3 className="text-lg sm:text-xl font-bold text-ppp-charcoal tracking-tight">
                {rep.name.split(" ")[0]}&apos;s Scorecard
              </h3>
              <p className="text-xs text-ppp-charcoal-500 mt-1">
                PPP fiscal-period KPIs · matches the FPRC reports
              </p>
            </div>
            <div className="text-right">
              <div className="font-condensed text-xs uppercase tracking-wide text-ppp-charcoal-500">
                Prior fiscal quarter
              </div>
              <div className="font-condensed text-sm sm:text-base font-bold text-ppp-navy mt-0.5">
                {fyLabel(scorecard.period.fy ?? scFy, scorecard.period.q ?? scQ)}
              </div>
              <div className="text-[10px] text-ppp-charcoal-400 mt-0.5">
                Matches FPRC card (last completed quarter)
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-4">
            {/* KPI 1 — % to Goal */}
            <ScorecardCard
              title="% to Goal"
              kpiTag="KPI 1"
              tooltip="Closed-Won sales (QuotedSubtotalWithChangeOrder__c, CloseDate in period) ÷ TotalQuota__c.QuotaAssigned__c (Owner / Active / FY26)."
            >
              {scorecard.sales.goal === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No quota set for {rep.name.split(" ")[0]} in this period.
                  </p>
                  <p className="text-[11px] text-ppp-charcoal-500">
                    Closed sales · {fmtMoneyK(scorecard.sales.totalSales / 1000)}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={[
                    "font-condensed text-3xl font-bold",
                    (scorecard.sales.pctToGoal ?? 0) >= 100 ? "text-ppp-green-700" :
                    (scorecard.sales.pctToGoal ?? 0) >= 75 ? "text-ppp-navy" :
                    "text-ppp-orange-700",
                  ].join(" ")}>
                    {scorecard.sales.pctToGoal !== null ? `${scorecard.sales.pctToGoal.toFixed(0)}%` : "—"}
                  </div>
                  <ProgressBar pct={scorecard.sales.pctToGoal ?? 0} />
                  <p className="text-[11px] text-ppp-charcoal-500">
                    {fmtMoneyK(scorecard.sales.totalSales / 1000)} of {fmtMoneyK(scorecard.sales.goal / 1000)} goal
                    {scorecard.sales.goalIsDerived && (
                      <span
                        className="ml-1 italic"
                        title="PPP doesn't maintain SubQuota__c monthly data this FY. Quarterly goal = annual TotalQuota__c ÷ 4."
                      >
                        (annual ÷ 4)
                      </span>
                    )}
                  </p>
                  {scorecard.sales.rank !== null && scorecard.sales.rankOf !== null && (
                    <p className="text-[11px] text-ppp-charcoal-500">
                      Rank <strong className="text-ppp-charcoal">#{scorecard.sales.rank}</strong> of {scorecard.sales.rankOf} field reps
                    </p>
                  )}
                </div>
              )}
            </ScorecardCard>

            {/* KPI 2 — Gross Margin vs Target */}
            <ScorecardCard
              title="Gross Margin"
              kpiTag="KPI 2"
              tooltip="Avg WorkOrder.Gross_Margin_Percent__c on completed WOs (EndDate in period). Target = User.Gross_Margin_Goal_Percent__c."
            >
              {scorecard.margin.avgGmPct === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No completed WOs with margin data in this period.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={[
                    "font-condensed text-3xl font-bold",
                    scorecard.margin.vsTarget !== null && scorecard.margin.vsTarget >= 0 ? "text-ppp-green-700" :
                    scorecard.margin.vsTarget !== null && scorecard.margin.vsTarget < -5 ? "text-ppp-orange-700" :
                    "text-ppp-navy",
                  ].join(" ")}>
                    {scorecard.margin.avgGmPct.toFixed(1)}%
                  </div>
                  {/* "vs target" sub-stat intentionally rendered ONLY when target
                      exists. PPP doesn't track per-rep GM targets in SF today
                      (verified via /api/admin/sf-field-discovery 2026-05-23 —
                      Gross_Margin_Goal_Percent__c isn't on the User object).
                      If PPP IT adds the field later this lights up automatically. */}
                  {scorecard.margin.target !== null && scorecard.margin.vsTarget !== null && (
                    <p className="text-[11px] text-ppp-charcoal-500">
                      Target {scorecard.margin.target.toFixed(1)}% ·{" "}
                      <strong className={scorecard.margin.vsTarget >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700"}>
                        {scorecard.margin.vsTarget >= 0 ? "+" : ""}{scorecard.margin.vsTarget.toFixed(1)}pp
                      </strong>
                    </p>
                  )}
                  <p className="text-[11px] text-ppp-charcoal-500">
                    Total GP: <strong className="text-ppp-charcoal">{fmtMoneyK(scorecard.margin.totalGpDollars / 1000)}</strong>
                    {" · "}
                    {scorecard.margin.completedCount} completed WO{scorecard.margin.completedCount === 1 ? "" : "s"}
                  </p>
                </div>
              )}
            </ScorecardCard>

            {/* KPI 3 — Close Rate (3 buckets) ─
                PPP DATA QUIRK: SF stages here don't include a "Closed Lost"
                type per the integration guide §4.5, so IsWon ≈ IsClosed and
                this metric trends very high (often 95%+). It's still the
                canonical PPP KPI 3 — the LeadGroup split is where the signal
                actually shows up (different reps perform very differently on
                marketing vs self-gen). */}
            <ScorecardCard
              title="Close Rate"
              kpiTag="KPI 3"
              tooltip="Won ÷ Opportunities CREATED in period. Self-gen = LeadGroup__c='Self-Generated'; everything else = marketing. NOTE: PPP's data trends high because of how their SF stage config handles 'lost' opps — the LeadGroup split is the actionable signal."
            >
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Overall</span>
                  <span className="font-condensed text-2xl font-bold text-ppp-navy">
                    {fmtPctOrDash(scorecard.closeRate.overall.pct, 0)}
                  </span>
                </div>
                <div className="text-[11px] text-ppp-charcoal-500 -mt-1">
                  {scorecard.closeRate.overall.won} of {scorecard.closeRate.overall.total} opps
                </div>
                <div className="border-t border-ppp-charcoal-100 pt-2 space-y-1.5">
                  <CloseRateRow label="Self-Gen" stats={scorecard.closeRate.selfGen} accent="green" />
                  <CloseRateRow label="Marketing" stats={scorecard.closeRate.marketing} accent="blue" />
                </div>
                {scorecard.closeRate.overall.total === 0 && (
                  <p className="text-[10px] text-ppp-charcoal-500 italic pt-1">
                    No opportunities created in this period yet.
                  </p>
                )}
              </div>
            </ScorecardCard>

            {/* KPI 3b — Sales Mix */}
            <ScorecardCard
              title="Sales Mix · $ Share"
              kpiTag="KPI 3b"
              tooltip="Of closed-won sales (CloseDate in period), the $-based self-generated share. Self-gen = LeadGroup__c='Self-Generated'."
            >
              {scorecard.salesMix.selfGenSharePct === null ? (
                <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
              ) : (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-green-700">
                    {scorecard.salesMix.selfGenSharePct.toFixed(0)}%
                  </div>
                  {/* Two-segment stacked bar — left green (self-gen) / right
                      blue (marketing). Replaces the misleading single-color
                      bar that filled only N% and made the remaining (100-N)%
                      look like missing data instead of marketing share. */}
                  <div className="h-2 w-full bg-ppp-charcoal-50 rounded overflow-hidden flex">
                    <div
                      className="h-full bg-ppp-green transition-[width] duration-500"
                      style={{ width: `${scorecard.salesMix.selfGenSharePct}%` }}
                      aria-hidden
                    />
                    <div
                      className="h-full bg-ppp-blue transition-[width] duration-500"
                      style={{ width: `${100 - scorecard.salesMix.selfGenSharePct}%` }}
                      aria-hidden
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-sm bg-ppp-green" aria-hidden />
                      <span className="text-ppp-charcoal-500">Self-gen</span>{" "}
                      <strong className="text-ppp-charcoal">{fmtMoneyK(scorecard.salesMix.selfGenDollars / 1000)}</strong>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-2 w-2 rounded-sm bg-ppp-blue" aria-hidden />
                      <span className="text-ppp-charcoal-500">Marketing</span>{" "}
                      <strong className="text-ppp-charcoal">{fmtMoneyK(scorecard.salesMix.marketingDollars / 1000)}</strong>
                    </span>
                  </div>
                </div>
              )}
            </ScorecardCard>

            {/* KPI 4 — Pricing Discipline */}
            <ScorecardCard
              title="Pricing · Rev / Labor Day"
              kpiTag="KPI 4"
              tooltip="Restricted to attendance-logged subset only (LaborDaysActual > 0). Materials % = SUM(TotalNonBillablePurchases__c) ÷ SUM(quoted)."
            >
              {scorecard.pricing.revPerLaborDayActual === null && scorecard.pricing.revPerLaborDayProjected === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-2xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No completed WOs with attendance logged in this period.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Projected</div>
                      <div className="font-condensed text-xl font-bold text-ppp-navy">
                        {scorecard.pricing.revPerLaborDayProjected !== null
                          ? `$${Math.round(scorecard.pricing.revPerLaborDayProjected).toLocaleString()}`
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Actual</div>
                      <div className={[
                        "font-condensed text-xl font-bold",
                        scorecard.pricing.revPerLaborDayActual !== null && scorecard.pricing.revPerLaborDayProjected !== null
                          && scorecard.pricing.revPerLaborDayActual >= scorecard.pricing.revPerLaborDayProjected
                          ? "text-ppp-green-700" : "text-ppp-orange-700",
                      ].join(" ")}>
                        {scorecard.pricing.revPerLaborDayActual !== null
                          ? `$${Math.round(scorecard.pricing.revPerLaborDayActual).toLocaleString()}`
                          : "—"}
                      </div>
                    </div>
                  </div>
                  {scorecard.pricing.materialsPct !== null && (
                    <p className="text-[11px] text-ppp-charcoal-500 border-t border-ppp-charcoal-100 pt-2">
                      Materials % of revenue:{" "}
                      <strong className={
                        scorecard.pricing.materialsPct <= 15 ? "text-ppp-green-700" :
                        scorecard.pricing.materialsPct <= 25 ? "text-ppp-charcoal" :
                        "text-ppp-orange-700"
                      }>
                        {scorecard.pricing.materialsPct.toFixed(1)}%
                      </strong>
                    </p>
                  )}
                  {scorecard.pricing.excludedNoAttendance > 0 && (
                    <p className="text-[10px] text-ppp-charcoal-500 italic">
                      {scorecard.pricing.excludedNoAttendance} WO{scorecard.pricing.excludedNoAttendance === 1 ? "" : "s"} excluded — no attendance logged
                    </p>
                  )}
                </div>
              )}
            </ScorecardCard>

            {/* KPI 5 — Appointments Activity (+ Speed-to-Estimate signal) */}
            <ScorecardCard
              title="Appointments"
              kpiTag="KPI 5"
              tooltip="Opportunity.AppointmentDate__c in period. Run = scheduled AND NOT Cancelled_Appointment__c. Speed-to-estimate = days from appointment to estimate sent."
            >
              {scorecard.appointments.scheduled === 0 ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">0</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No appointments scheduled in this period.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-condensed text-3xl font-bold text-ppp-navy">
                      {scorecard.appointments.run}
                    </span>
                    <span className="text-xs text-ppp-charcoal-500">
                      run / {scorecard.appointments.scheduled} scheduled
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-ppp-charcoal-500">Estimates sent</span>{" "}
                      <strong className="text-ppp-green-700">{fmtPctOrDash(scorecard.appointments.estimatesSentPct, 0)}</strong>
                    </div>
                    <div>
                      <span className="text-ppp-charcoal-500">Cancelled</span>{" "}
                      <strong className={
                        (scorecard.appointments.cancelledPct ?? 0) > 20 ? "text-ppp-orange-700" : "text-ppp-charcoal"
                      }>
                        {fmtPctOrDash(scorecard.appointments.cancelledPct, 0)}
                      </strong>
                    </div>
                  </div>
                  {scorecard.appointments.avgDaysToEstimate !== null && (
                    <div className="border-t border-ppp-charcoal-100 pt-2 mt-1">
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <span className="text-[11px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">
                          Speed to estimate
                        </span>
                        <span className={[
                          "font-condensed text-base sm:text-lg font-bold whitespace-nowrap",
                          scorecard.appointments.avgDaysToEstimate <= 3 ? "text-ppp-green-700" :
                          scorecard.appointments.avgDaysToEstimate <= 7 ? "text-ppp-navy" :
                          "text-ppp-orange-700",
                        ].join(" ")}>
                          {scorecard.appointments.avgDaysToEstimate.toFixed(1)} days
                        </span>
                      </div>
                      {scorecard.appointments.slowEstimatePct !== null && scorecard.appointments.slowEstimatePct > 0 && (
                        <p className="text-[10px] text-ppp-charcoal-500 mt-0.5">
                          <strong className={
                            scorecard.appointments.slowEstimatePct > 30 ? "text-ppp-orange-700" : "text-ppp-charcoal"
                          }>
                            {scorecard.appointments.slowEstimatePct.toFixed(0)}%
                          </strong>{" "}
                          took 7+ days to send estimate
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </ScorecardCard>

            {/* KPI 6 — Pipeline Health */}
            <ScorecardCard
              title="Pipeline · Stale Estimates"
              kpiTag="KPI 6"
              tooltip="Open Opps created in the last 12 months (the snapshot window) with Estimate_Sent__c AND Date_Estimate_Sent__c < TODAY−30. Opps created >12 months ago aren't in scope — on PPP's 3-4 week cycle a year-old 'open' opp is almost always a dead deal nobody closed, so this focuses on actionable recent pipeline."
            >
              {scorecard.pipeline.openOpps === 0 ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No open opportunities in the last 12 months.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={[
                    "font-condensed text-3xl font-bold",
                    (scorecard.pipeline.stalePct ?? 0) <= 10 ? "text-ppp-green-700" :
                    (scorecard.pipeline.stalePct ?? 0) <= 25 ? "text-ppp-charcoal" :
                    "text-ppp-orange-700",
                  ].join(" ")}>
                    {fmtPctOrDash(scorecard.pipeline.stalePct, 0)}
                  </div>
                  <p className="text-[11px] text-ppp-charcoal-500">
                    <strong className="text-ppp-charcoal">{scorecard.pipeline.staleEstimates}</strong> stale of {scorecard.pipeline.openOpps} open opps <span className="text-ppp-charcoal-400">(last 12 mo)</span>
                  </p>
                  <p className="text-[10px] text-ppp-charcoal-500 italic">
                    Stale = estimate sent &gt; 30 days ago
                  </p>
                </div>
              )}
            </ScorecardCard>

            {/* KPI 7 — Production Quality */}
            <ScorecardCard
              title="Production Quality"
              kpiTag="KPI 7"
              tooltip="Jobs completed vs sold + reviews + complaints + change orders. Reviews by Account.OwnerId; complaints by Opportunity.OwnerId narrowed to FPRC's 2 true types (Dissatisfied Customer, Service Call). Change Orders $ = SUM(WorkOrder.TotalChangeOrder__c) over completed WOs (already nets to Approved/Approved-Auto via SF rollup)."
            >
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-condensed text-2xl font-bold text-ppp-navy">
                    {scorecard.production.jobsCompleted}
                  </span>
                  <span className="text-xs text-ppp-charcoal-500">
                    completed / {scorecard.production.oppsWon} sold
                  </span>
                </div>
                {scorecard.production.completionRatio !== null && (
                  <ProgressBar pct={scorecard.production.completionRatio} />
                )}
                <div className="grid grid-cols-3 gap-2 text-center pt-2 border-t border-ppp-charcoal-100">
                  <div>
                    <div className="font-condensed text-base font-bold text-ppp-green-700">
                      {scorecard.production.goodReviews}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">Good rev.</div>
                  </div>
                  <div>
                    <div className={[
                      "font-condensed text-base font-bold",
                      scorecard.production.badReviews > 0 ? "text-ppp-orange-700" : "text-ppp-charcoal-200",
                    ].join(" ")}>
                      {scorecard.production.badReviews}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">Bad rev.</div>
                  </div>
                  <div>
                    <div className={[
                      "font-condensed text-base font-bold",
                      scorecard.production.complaints > 0 ? "text-ppp-orange-700" : "text-ppp-charcoal-200",
                    ].join(" ")}>
                      {scorecard.production.complaints}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">Cases</div>
                  </div>
                </div>
                {scorecard.production.changeOrders > 0 && (
                  <div className="flex items-baseline justify-between pt-2 border-t border-ppp-charcoal-100">
                    <span className="text-[10px] uppercase tracking-wide text-ppp-charcoal-500">
                      Change Orders
                    </span>
                    <span className="font-condensed text-sm font-bold text-ppp-navy">
                      {fmtMoneyK(scorecard.production.changeOrders)}
                    </span>
                  </div>
                )}
              </div>
            </ScorecardCard>

            {/* KPI 8 — Money Flow */}
            <ScorecardCard
              title="Money Flow"
              kpiTag="KPI 8"
              tooltip="Transaction__c by WorkOrder.OwnerId, Date__c in period. Payments In / Labor Payouts / Total Purchases."
            >
              <div className="space-y-2">
                <FlowRow label="Payments In" amount={scorecard.moneyFlow.moneyCollected} accent="green" />
                <FlowRow label="Labor Payouts" amount={scorecard.moneyFlow.laborPaidOut} accent="navy" />
                <FlowRow label="Purchases" amount={scorecard.moneyFlow.purchases} accent="charcoal" />
                {scorecard.moneyFlow.moneyCollected === 0 &&
                  scorecard.moneyFlow.laborPaidOut === 0 &&
                  scorecard.moneyFlow.purchases === 0 && (
                    <p className="text-[10px] text-ppp-charcoal-500 italic">
                      No Transaction__c records for this rep in this period.
                    </p>
                )}
              </div>
            </ScorecardCard>

            {/* KPI 9 — Commissions ─ Draw / under-over comparison rendered
                ONLY when User.Quarterly_Draw__c is populated. PPP doesn't
                track quarterly draws in SF today (verified via field
                discovery 2026-05-23), so reps see just "Earned" cleanly
                instead of a "No draw set" forever-message. Lights up
                automatically if PPP IT adds the field later. */}
            <ScorecardCard
              title="Commissions Earned"
              kpiTag="KPI 9"
              tooltip="CFY-to-date. Earned = Payment_Out with PayeeType=Sales + Description contains 'Draw', Payee matches rep name (incl. shadow '<name>-inactive'/'-portal' and 'LC <name>' labor-company alias). Draw Received = Quarterly Draw × fiscal-quarter index (Q1→×1 … Q4→×4)."
            >
              {scorecard.commissions.earned === 0 ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No commission Draw payouts (PayeeType=Sales) for this rep in this fiscal year.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-condensed text-2xl font-bold text-ppp-navy">
                      {fmtCommissionDollars(scorecard.commissions.earned)}
                    </span>
                    <span className="text-xs text-ppp-charcoal-500">earned · CFY to date</span>
                  </div>
                  {scorecard.commissions.drawReceived !== null && (
                    <p className="text-[11px] text-ppp-charcoal-500">
                      Draw received: {fmtCommissionDollars(scorecard.commissions.drawReceived)}
                    </p>
                  )}
                  {scorecard.commissions.difference !== null && (
                    <p className="text-xs">
                      <span className="text-ppp-charcoal-500">Net: </span>
                      <strong className={scorecard.commissions.difference >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700"}>
                        {scorecard.commissions.difference >= 0 ? "+" : ""}{fmtCommissionDollars(scorecard.commissions.difference)}
                      </strong>
                      <span className="text-[11px] text-ppp-charcoal-500 ml-1">
                        ({scorecard.commissions.difference >= 0 ? "underpaid" : "overpaid"})
                      </span>
                    </p>
                  )}
                </div>
              )}
            </ScorecardCard>
          </div>

          {/* Attendance completeness — data-quality signal. When < 80%
              logged, this is a real warning: KPI 4 (Pricing / Rev per
              Labor Day) numbers above are based on the logged subset only,
              so a small subset = unreliable signal. Promoted from italic
              footnote to a visible amber banner so CEO/manager don't miss
              it on mobile scan. */}
          {scorecard.attendance.completed > 0 && (
            <>
              {(scorecard.attendance.completenessPct ?? 100) < 80 ? (
                <div className="mt-3 bg-ppp-orange-50 border border-ppp-orange-100 rounded-lg px-4 py-2.5 flex items-start gap-2 text-[11px] text-ppp-orange-700">
                  <span aria-hidden className="text-sm leading-none">⚠</span>
                  <div>
                    <strong>Data quality warning · </strong>
                    Crew attendance logged on only{" "}
                    <strong>{scorecard.attendance.logged}</strong> of{" "}
                    {scorecard.attendance.completed} completed WOs
                    {scorecard.attendance.completenessPct !== null && (
                      <> ({scorecard.attendance.completenessPct.toFixed(0)}%)</>
                    )}
                    . The Pricing / Rev-per-Labor-Day numbers above are
                    based on the logged subset only — interpret with caution.
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-[11px] text-ppp-charcoal-500 italic px-1">
                  Data quality · Crew attendance logged on{" "}
                  <strong className="text-ppp-charcoal">
                    {scorecard.attendance.logged}
                  </strong>{" "}
                  of {scorecard.attendance.completed} completed WOs
                  {scorecard.attendance.completenessPct !== null && (
                    <> ({scorecard.attendance.completenessPct.toFixed(0)}%)</>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

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

      {/* ─── Activity stats ───
          Real Salesforce activity. The previous version used opp-count
          proxies (rep.appointmentsHeld = rep.quotesSent = a.total) which
          rendered as if they were real appointment / quote counts — they
          weren't. Now reads from KPI 5 (AppointmentDate__c + Estimate_Sent__c)
          when scorecard is available, falls back to the old proxy with a
          clearly-labeled caveat for mock data. */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
          <h3 className="text-base font-semibold text-ppp-charcoal mb-1">
            Activity · {scorecard ? scorecard.period.label : "Last 30 Days"}
          </h3>
          <p className="text-xs text-ppp-charcoal-500 mb-5">
            {scorecard
              ? "Real appointment + estimate activity from Salesforce, fiscal-period scoped"
              : "Volume and velocity behind the headline numbers"}
          </p>
          {scorecard ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <ActivityStat
                label="Appointments scheduled"
                value={scorecard.appointments.scheduled}
              />
              <ActivityStat
                label="Appointments run"
                value={scorecard.appointments.run}
                hint={scorecard.appointments.scheduled > 0
                  ? `${scorecard.appointments.scheduled - scorecard.appointments.run} cancelled`
                  : undefined}
              />
              <ActivityStat
                label="Estimates sent"
                value={Math.round(((scorecard.appointments.estimatesSentPct ?? 0) / 100) * scorecard.appointments.run)}
                hint={scorecard.appointments.estimatesSentPct !== null
                  ? `${scorecard.appointments.estimatesSentPct.toFixed(0)}% of run`
                  : undefined}
              />
              <ActivityStat
                label="Opps closed-won"
                value={scorecard.production.oppsWon}
                hint={scorecard.production.jobsCompleted > 0
                  ? `${scorecard.production.jobsCompleted} jobs completed`
                  : undefined}
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <ActivityStat label="Opportunities" value={rep.appointmentsHeld} hint="opp count proxy" />
              <ActivityStat label="Opportunities" value={rep.quotesSent} hint="opp count proxy" />
              <ActivityStat label="Avg days to close" value={rep.daysAvgClose} suffix=" days" />
              <ActivityStat
                label="Quote → Close"
                value={Math.round((rep.closeRate / 100) * rep.quotesSent)}
                hint={`of ${rep.quotesSent} quotes`}
              />
            </div>
          )}
        </div>
      </section>

      {/* ─── Upcoming work (future-dated open WOs) ─── */}
      {upcomingWork.length > 0 && (
        <section>
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-ppp-charcoal">Upcoming Work</h3>
                <p className="text-xs text-ppp-charcoal-500 mt-0.5">
                  Open WOs scheduled ahead — soonest first
                </p>
              </div>
              <span className="text-[11px] font-medium text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 px-2 py-0.5 rounded-full">
                {upcomingWork.length} job{upcomingWork.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                  <tr>
                    <th className="text-left px-6 py-3">Customer</th>
                    <th className="text-left px-6 py-3">Stage</th>
                    <th className="text-right px-6 py-3">Quoted</th>
                    <th className="text-right px-6 py-3">Scheduled</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {upcomingWork.map((d) => (
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
                      <td className="px-6 py-3.5 text-right font-semibold text-ppp-charcoal">
                        {d.amount > 0 ? fmtMoneyK(d.amount) : <span className="text-ppp-charcoal-500 font-normal italic">TBD</span>}
                      </td>
                      <td className="px-6 py-3.5 text-right text-ppp-charcoal-500">
                        {d.closedAt ?? `${d.daysInStage}d open`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
              {upcomingWork.map((d) => (
                <li key={d.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ppp-charcoal truncate">
                        {d.customer}
                        <CustomerBadges acct={accountByName.get(d.customer)} />
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                        {d.closedAt ?? `${d.daysInStage}d open`}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-ppp-charcoal">
                        {d.amount > 0 ? fmtMoneyK(d.amount) : <span className="text-ppp-charcoal-500 font-normal italic">TBD</span>}
                      </div>
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
      )}

      {/* ─── Recent CLOSED deals ─── */}
      <section>
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100">
            <h3 className="text-base font-semibold text-ppp-charcoal">Recent Closed Deals</h3>
            <p className="text-xs text-ppp-charcoal-500 mt-0.5">
              Last 8 jobs marked Paid in Full, Complete, or Cancelled
            </p>
          </div>

          {recentDeals.length === 0 && (
            <div className="px-5 sm:px-6 py-10 text-center text-sm text-ppp-charcoal-500">
              No closed deals yet for this rep.
            </div>
          )}

          {recentDeals.length > 0 && (<>
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
          </>)}
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

/* ─── PPP Scorecard helpers (Katie's REP_PROFILES_INTEGRATION §6 cards) ─── */

/** Format a (possibly null) percent number as "XX.X%" or "—". */
function fmtPctOrDash(pct: number | null, decimals: number = 1): string {
  if (pct === null || isNaN(pct)) return "—";
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Currency formatter tuned for the Commissions card. fmtMoneyK rounds to
 * nearest $1K which destroys precision on smaller commission amounts —
 * $1,500 rendered as "$2K" was misleading reps about their actual earned
 * payouts. This helper uses full dollars (no abbreviation) under $10K
 * and abbreviates only at scale where the precision doesn't matter.
 */
function fmtCommissionDollars(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10_000) {
    // Full precision — e.g. $1,500 / -$248 / $9,999
    return `${n < 0 ? "-" : ""}$${Math.round(abs).toLocaleString()}`;
  }
  // Abbreviate above $10K — e.g. $42.1K / $128K
  const k = abs / 1000;
  const formatted = k >= 100 ? Math.round(k).toString() : k.toFixed(1);
  return `${n < 0 ? "-" : ""}$${formatted}K`;
}

/**
 * Uniform card shell for the scorecard grid. Keeps title / kpiTag / tooltip
 * layout consistent so the eye can scan across the 9 KPIs without re-anchoring.
 * The `tooltip` value is also surfaced as a visible info dot for non-hover
 * surfaces (mobile) — accessibility first.
 */
/**
 * Uniform card shell. The "ⓘ Info" affordance (line below the title) lets
 * tap users on mobile see the KPI definition — the native `title` tooltip
 * doesn't render reliably on touch. Click toggles an inline panel; safer
 * than a hover-only tooltip for CEO-on-phone use.
 */
function ScorecardCard({
  title,
  kpiTag,
  tooltip,
  children,
}: {
  title: string;
  kpiTag: string;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-3 sm:p-5 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-2 sm:mb-3">
        <h4 className="text-[13px] sm:text-sm font-semibold text-ppp-charcoal leading-tight">{title}</h4>
        <span
          className="text-[9px] uppercase tracking-wide font-semibold text-ppp-charcoal-500 bg-ppp-charcoal-50 px-1.5 py-0.5 rounded shrink-0 cursor-help"
          title={tooltip}
        >
          {kpiTag}
        </span>
      </div>
      <div className="flex-1">{children}</div>
      {/* Inline help — collapsible details element. Tap "What this measures"
          on phones to see the KPI definition (replaces the desktop-only
          hover tooltip on the KPI tag). */}
      <details className="mt-2 sm:mt-3">
        <summary className="text-[10px] text-ppp-charcoal-500 cursor-pointer hover:text-ppp-blue list-none flex items-center gap-1">
          <span aria-hidden>ⓘ</span> What this measures
        </summary>
        <p className="text-[10px] text-ppp-charcoal-500 mt-1.5 leading-relaxed">
          {tooltip}
        </p>
      </details>
    </div>
  );
}

/** Horizontal progress bar — capped at 100% visually but the headline number
 *  shows the true value above so "120% to goal" renders cleanly. */
function ProgressBar({ pct, colorClass = "bg-ppp-blue" }: { pct: number; colorClass?: string }) {
  const capped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full bg-ppp-charcoal-50 rounded">
      <div
        className={`h-full ${colorClass} rounded transition-[width] duration-500`}
        style={{ width: `${Math.max(2, capped)}%` }}
      />
    </div>
  );
}

/** Inline row for the Close Rate card's self-gen / marketing sub-buckets. */
function CloseRateRow({
  label,
  stats,
  accent,
}: {
  label: string;
  stats: { won: number; total: number; pct: number | null };
  accent: "green" | "blue";
}) {
  const dotClass = accent === "green" ? "bg-ppp-green" : "bg-ppp-blue";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-ppp-charcoal flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        {label}
      </span>
      <span className="text-[11px] text-ppp-charcoal-500">
        <strong className="text-ppp-charcoal">{fmtPctOrDash(stats.pct, 0)}</strong>
        {" · "}
        {stats.won}/{stats.total}
      </span>
    </div>
  );
}

/** Inline row for the Money Flow card. */
function FlowRow({
  label,
  amount,
  accent,
}: {
  label: string;
  amount: number;
  accent: "green" | "navy" | "charcoal";
}) {
  const valueClass =
    accent === "green" ? "text-ppp-green-700" :
    accent === "navy" ? "text-ppp-navy" :
    "text-ppp-charcoal";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ppp-charcoal-500">{label}</span>
      <span className={`font-condensed text-lg font-bold ${valueClass}`}>
        {amount === 0 ? "—" : fmtMoneyK(amount / 1000)}
      </span>
    </div>
  );
}
