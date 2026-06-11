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
  getRepRecentlySentQuotesFor,
} from "@/lib/data-source";
import { deriveRepsForPeriod, deriveRepAccountStats } from "@/lib/salesforce/derive";
import { deriveRepScorecard, type RepScorecard } from "@/lib/salesforce/rep-scorecard";
import { fyLabel, resolveScorecardPeriod } from "@/lib/fiscal-year";
import ScorecardPeriodPicker from "@/components/scorecard-period-picker";
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
  const recentlySentQuotes = getRepRecentlySentQuotesFor(bundle, rep.id) ?? [];
  const hasActivity =
    monthly.some((m) => m.revenue > 0) || recentDeals.length > 0 || upcomingWork.length > 0;
  const noHistoricalData = !hasActivity;

  // Account stats — only when on live data. Repeat-customer counts,
  // lifetime revenue across their accounts, BM-retailer flags, top account.
  const accountStats = bundle.snapshot
    ? deriveRepAccountStats(bundle.snapshot, rep.id)
    : null;

  // KPI scorecard — period selectable via ?scPeriod= (Katie 2026-05-29).
  // Defaults to the PRIOR (just-completed) fiscal quarter, which is what the
  // FPRC report cards report (the in-progress quarter is a partial that won't
  // reconcile). Options: pfq (default) / cfq / pfy / cfy.
  // Skipped on mock data (no quotas/transactions/reviews to derive from).
  const scSel = resolveScorecardPeriod(typeof sp.scPeriod === "string" ? sp.scPeriod : undefined);
  const scorecard: RepScorecard | null = bundle.snapshot
    ? deriveRepScorecard(bundle.snapshot, rep.id, scSel.period)
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
  // halfDelta = null when prior6 = 0 (the % is mathematically undefined). Lets
  // the UI render "—" / "New" instead of a misleading "0%" or "+Infinity%".
  // Per Katie 2026-06-10: the "0%" in this slot kept confusing reps.
  const halfDelta: number | null = prior6 === 0
    ? null
    : Math.round(((last6 - prior6) / prior6) * 100);
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
                <span
                  className="text-ppp-charcoal-500"
                  title="Most-common Service Territory across the rep's recent Accounts (Account.Service_Territory__c)."
                >
                  {rep.region}
                </span>
                <span className="text-ppp-charcoal-200">·</span>
                <span
                  className={[
                    "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border",
                    rep.serviceLine === "Commercial"
                      ? "text-ppp-orange-700 bg-ppp-orange-50 border-ppp-orange-100"
                      : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
                  ].join(" ")}
                  title="Service line — currently derived from User.UserRole.Name + Profile.Name. Add User.Service_Line__c in SF for an authoritative read."
                >
                  {rep.serviceLine}
                </span>
                <span className="text-ppp-charcoal-200">·</span>
                <span
                  className="text-ppp-charcoal-500"
                  title="Time since the User record was created in Salesforce (User.CreatedDate)."
                >
                  {tenure(rep.startedAt)} at PPP
                </span>
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
                      title="Days since this rep's most recent Appointment or Work Order Completion in Salesforce."
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
                halfDelta === null
                  ? "text-ppp-charcoal-500"
                  : halfDelta > 0 ? "text-ppp-green-700"
                  : halfDelta < 0 ? "text-ppp-orange-700"
                  : "text-ppp-charcoal-500",
              ].join(" ")}
              title="Revenue closed in the last 6 months vs the 6 months before that. Independent of the period picker below. Helps spot acceleration or slowdown without flipping fiscal periods."
            >
              {halfDelta === null
                ? (last6 > 0 ? "New revenue (no prior 6mo to compare)" : "No revenue in the last 12 mo")
                : `${halfDelta > 0 ? "+" : ""}${halfDelta}% last 6mo vs prior 6mo`}
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
          <KPICard
            label="Revenue Sold"
            value={fmtMoneyK(rep.revenueSold)}
            change={dRev.text}
            trend={dRev.trend}
            accent="blue"
            hint="Total $ value of opportunities you won (Opp.IsWon = true · CloseDate in the last 12 months). Source field: QuotedSubtotalWithChangeOrder__c."
          />
          <KPICard
            label="Close Rate"
            value={`${rep.closeRate.toFixed(1)}%`}
            change={dClose.text}
            trend={dClose.trend}
            accent="green"
            hint="Won opps ÷ opps created in the last 12 months. Excludes Estimate / Appointment WOs + cancelled deals. Trends high vs other CRMs because PPP's SF stages don't include a 'Closed Lost' type."
          />
          <KPICard
            label="Avg Ticket"
            value={fmtMoneyK(rep.avgTicket)}
            change={dTicket.text}
            trend={dTicket.trend}
            accent="orange"
            hint="Average $ size of a won deal in the last 12 months (Revenue Sold ÷ # of won opps)."
          />
          <KPICard
            label="Open Pipeline"
            value={fmtMoneyK(rep.openPipeline)}
            change={dPipe.text}
            trend={dPipe.trend}
            accent="blue"
            hint="Total $ value of opportunities still open right now (Opp.IsClosed = false). Snapshot at run-time."
          />
        </div>
        <p className="mt-2 text-[11px] text-ppp-charcoal-500 italic px-1">
          <strong>Close Rate</strong> = sold ÷ opps (opps that became a real paid job ÷ opps created). Excludes Estimate / Appointment WOs and cancelled / dead deals. See <strong>Scorecard · Close Rate</strong> below for PPP&apos;s canonical KPI 3 metric (IsWon-based, fiscal-period). <em>Conversion Rate (leads → opps) is coming once lead data is wired.</em>
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
              <ScorecardPeriodPicker value={scSel.key} />
              <div className="font-condensed text-sm sm:text-base font-bold text-ppp-navy mt-1">
                {fyLabel(scorecard.period.fy ?? scSel.period.fy, scorecard.period.q ?? scSel.period.q)}
              </div>
              <div className="text-[10px] text-ppp-charcoal-400 mt-0.5">
                {scSel.inProgress ? "In-progress period (partial)" : "Completed period · matches FPRC card"}
              </div>
            </div>
          </div>

          {/* KPI 1 spans the full width per Maloney layout — 5 sub-stats + a
              12-month prior-year overlay chart. The rest of the cards live in
              a 3-col grid below. */}
          <div className="mb-2.5 sm:mb-4">
            <ScorecardCard
              title="Revenue Performance"
              kpiTag="KPI 1"
              tooltip="Won Opps · Created CFY · Close Date PFQ. Goal = sum of monthly Owner SubQuotas in the quarter."
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 mb-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Total Sales</div>
                  <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy" title={`$${Math.round(scorecard.sales.totalSales).toLocaleString()}`}>
                    {fmtMoneyK(scorecard.sales.totalSales / 1000)}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">{scorecard.period.label}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Period Goal</div>
                  <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-charcoal" title={scorecard.sales.goal !== null ? `$${Math.round(scorecard.sales.goal).toLocaleString()}` : undefined}>
                    {scorecard.sales.goal !== null ? fmtMoneyK(scorecard.sales.goal / 1000) : "—"}
                  </div>
                  {scorecard.sales.goalIsDerived && (
                    <div
                      className="text-[10px] text-ppp-charcoal-500 italic"
                      title="PPP hasn't populated SubQuota__c monthly data for FY26. Quarterly goal = annual ÷ 4 until IT backfills."
                    >
                      (annual ÷ 4)
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">% to Goal</div>
                  <div className={[
                    "font-condensed text-2xl sm:text-3xl font-bold",
                    (scorecard.sales.pctToGoal ?? 0) >= 100 ? "text-ppp-green-700" :
                    (scorecard.sales.pctToGoal ?? 0) >= 75 ? "text-ppp-navy" :
                    "text-ppp-orange-700",
                  ].join(" ")}>
                    {scorecard.sales.pctToGoal !== null ? `${scorecard.sales.pctToGoal.toFixed(1)}%` : "—"}
                  </div>
                  <div className="mt-1"><ProgressBar pct={scorecard.sales.pctToGoal ?? 0} /></div>
                </div>
                {scorecard.sales.rank !== null && scorecard.sales.rankOf !== null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Rank vs Team</div>
                    <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy">
                      {scorecard.sales.rank} / {scorecard.sales.rankOf}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500">field reps</div>
                  </div>
                )}
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Prior YOY</div>
                  <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-charcoal" title={`$${Math.round(scorecard.priorYoy.amount).toLocaleString()}`}>
                    {scorecard.priorYoy.amount > 0 ? fmtMoneyK(scorecard.priorYoy.amount / 1000) : "—"}
                  </div>
                  {scorecard.priorYoy.deltaPct !== null && (
                    <div className={[
                      "text-[10px] font-semibold",
                      scorecard.priorYoy.deltaPct >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700",
                    ].join(" ")}>
                      {scorecard.priorYoy.deltaPct >= 0 ? "+" : ""}{scorecard.priorYoy.deltaPct.toFixed(1)}% vs current
                    </div>
                  )}
                </div>
              </div>
              {/* Monthly bar chart with prior-year overlay — Maloney style. */}
              <RevenueYoyChart data={scorecard.monthlySalesChart} />
            </ScorecardCard>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-4">

            {/* KPI 2 — Appointments Activity
                Maloney FPRC layout: APPTS RUN headline + CANCELLED + ESTIMATES
                SENT as 3-stat grid. Speed-to-estimate dropped per PDF spec. */}
            <ScorecardCard
              title="Appointments Activity"
              kpiTag="KPI 2"
              tooltip="Opp Created CFY · Appointment Scheduled date PFQ."
            >
              {scorecard.appointments.scheduled === 0 ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">0</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No appointments scheduled in this period.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Appts Run</div>
                    <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">
                      {scorecard.appointments.run}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500">{scorecard.appointments.scheduled} Scheduled</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Cancelled</div>
                    <div className={[
                      "font-condensed text-xl sm:text-2xl font-bold",
                      (scorecard.appointments.cancelledPct ?? 0) > 20 ? "text-ppp-orange-700" : "text-ppp-navy",
                    ].join(" ")}>
                      {fmtPctOrDash(scorecard.appointments.cancelledPct, 1)}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500">
                      {scorecard.appointments.cancelledCount} of {scorecard.appointments.scheduled}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Estimates Sent</div>
                    <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-green-700">
                      {fmtPctOrDash(scorecard.appointments.estimatesSentPct, 1)}
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500">
                      {scorecard.appointments.runWithEstimate} of {scorecard.appointments.run}
                    </div>
                  </div>
                </div>
              )}
            </ScorecardCard>

            {/* KPI 3 — Pipeline Management
                Maloney FPRC: 3-stat row Open Opps | Stale Estimates | % Stale. */}
            <ScorecardCard
              title="Pipeline Management"
              kpiTag="KPI 3"
              tooltip="Open Opps · Created all-time · Status Open · snapshot at run date."
            >
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Open Opps</div>
                  <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">
                    {scorecard.pipeline.openOpps}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Stale Estimates</div>
                  <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">
                    {scorecard.pipeline.staleEstimates}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">Sent &gt; 30d ago</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">% Stale</div>
                  <div className={[
                    "font-condensed text-xl sm:text-2xl font-bold",
                    (scorecard.pipeline.stalePct ?? 0) <= 10 ? "text-ppp-green-700" :
                    (scorecard.pipeline.stalePct ?? 0) <= 25 ? "text-ppp-navy" :
                    "text-ppp-orange-700",
                  ].join(" ")}>
                    {fmtPctOrDash(scorecard.pipeline.stalePct, 1)}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">Cutoff {scorecard.pipeline.cutoffDate}</div>
                </div>
              </div>
            </ScorecardCard>

            {/* KPI 4A — Close Rate
                Maloney FPRC: 3-stat row Self-Gen | Marketing | Overall. */}
            <ScorecardCard
              title="Close Rate"
              kpiTag="KPI 4A"
              tooltip="Opp Created CFY · Close Date PFQ · won ÷ cohort."
            >
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Self-Gen</div>
                  <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-green-700">
                    {fmtPctOrDash(scorecard.closeRate.selfGen.pct, 1)}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">{scorecard.closeRate.selfGen.won} won / {scorecard.closeRate.selfGen.total}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Marketing</div>
                  <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-blue-700">
                    {fmtPctOrDash(scorecard.closeRate.marketing.pct, 1)}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">{scorecard.closeRate.marketing.won} won / {scorecard.closeRate.marketing.total}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Overall</div>
                  <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">
                    {fmtPctOrDash(scorecard.closeRate.overall.pct, 1)}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">{scorecard.closeRate.overall.won} won / {scorecard.closeRate.overall.total}</div>
                </div>
              </div>
              {scorecard.closeRate.overall.total === 0 && (
                <p className="text-[10px] text-ppp-charcoal-500 italic mt-2">
                  No opportunities in this period yet.
                </p>
              )}
            </ScorecardCard>

            {/* KPI 4B — Sales Mix · Self-Gen vs Marketing
                Maloney FPRC: 3-col stat (Self-Gen % | Marketing % | Total Won)
                + Below/Above goal badge under Self-Gen %. */}
            <ScorecardCard
              title="Sales Mix · Self-Gen vs Marketing"
              kpiTag="KPI 4B"
              tooltip="Won Opps · Created CFY · Close Date PFQ."
            >
              {scorecard.salesMix.selfGenSharePct === null ? (
                <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
              ) : (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Self-Gen % of Sales</div>
                      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-green-700">
                        {scorecard.salesMix.selfGenSharePct.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-ppp-charcoal-500" title={`$${Math.round(scorecard.salesMix.selfGenDollars).toLocaleString()}`}>
                        {fmtMoneyK(scorecard.salesMix.selfGenDollars / 1000)}
                      </div>
                      {scorecard.salesMix.goalPct !== null && scorecard.salesMix.vsGoal !== null && (
                        <div className={[
                          "inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide",
                          scorecard.salesMix.vsGoal >= 0 ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-orange-50 text-ppp-orange-700",
                        ].join(" ")}>
                          Goal {scorecard.salesMix.goalPct.toFixed(0)}% · {scorecard.salesMix.vsGoal >= 0 ? "Above" : "Below"}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Marketing % of Sales</div>
                      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-blue-700">
                        {(100 - scorecard.salesMix.selfGenSharePct).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-ppp-charcoal-500" title={`$${Math.round(scorecard.salesMix.marketingDollars).toLocaleString()}`}>
                        {fmtMoneyK(scorecard.salesMix.marketingDollars / 1000)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Total Won Sales</div>
                      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy" title={`$${Math.round(scorecard.salesMix.totalWonSales).toLocaleString()}`}>
                        {fmtMoneyK(scorecard.salesMix.totalWonSales / 1000)}
                      </div>
                      <div className="text-[10px] text-ppp-charcoal-500">{scorecard.salesMix.totalWonOpps} Won Opps</div>
                    </div>
                  </div>
                  {scorecard.salesMix.goalPct === null && (
                    <p className="text-[10px] text-ppp-charcoal-500 italic">
                      No Self-Gen Sales Goal set for this rep.
                    </p>
                  )}
                </div>
              )}
            </ScorecardCard>

            {/* KPI 5 — Pricing Discipline
                Maloney FPRC: 3-stat row Materials % | Projected $/Day | Actual
                $/Day. Actual carries a "+$X vs Projected" $-denominated delta
                (NOT percent). */}
            <ScorecardCard
              title="Pricing Discipline"
              kpiTag="KPI 5"
              tooltip="Opp Close Date CFY · WO End Date PFQ · Status Closed / Complete Paid in Full. $/Day over WOs with attendance logged."
            >
              {scorecard.pricing.revPerLaborDayActual === null && scorecard.pricing.revPerLaborDayProjected === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-2xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No completed WOs with attendance logged in this period.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Materials %</div>
                      <div className={[
                        "font-condensed text-xl sm:text-2xl font-bold",
                        scorecard.pricing.materialsPct === null ? "text-ppp-charcoal-400" :
                        scorecard.pricing.materialsPct <= 15 ? "text-ppp-green-700" :
                        scorecard.pricing.materialsPct <= 25 ? "text-ppp-navy" :
                        "text-ppp-orange-700",
                      ].join(" ")}>
                        {scorecard.pricing.materialsPct !== null ? `${scorecard.pricing.materialsPct.toFixed(1)}%` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Projected $/Day</div>
                      <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy">
                        {scorecard.pricing.revPerLaborDayProjected !== null
                          ? `$${Math.round(scorecard.pricing.revPerLaborDayProjected).toLocaleString()}`
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Actual $/Day</div>
                      <div className={[
                        "font-condensed text-xl sm:text-2xl font-bold",
                        scorecard.pricing.actualVsProjectedDollar === null ? "text-ppp-navy" :
                        scorecard.pricing.actualVsProjectedDollar >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700",
                      ].join(" ")}>
                        {scorecard.pricing.revPerLaborDayActual !== null
                          ? `$${Math.round(scorecard.pricing.revPerLaborDayActual).toLocaleString()}`
                          : "—"}
                      </div>
                      {scorecard.pricing.actualVsProjectedDollar !== null && (
                        <div className={[
                          "text-[10px] font-semibold",
                          scorecard.pricing.actualVsProjectedDollar >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700",
                        ].join(" ")}>
                          {scorecard.pricing.actualVsProjectedDollar >= 0 ? "+" : "-"}${Math.abs(Math.round(scorecard.pricing.actualVsProjectedDollar)).toLocaleString()} vs Projected
                        </div>
                      )}
                    </div>
                  </div>
                  {scorecard.pricing.excludedNoAttendance > 0 && (
                    <p className="text-[10px] text-ppp-orange-700 font-semibold">
                      Excludes {scorecard.pricing.excludedNoAttendance} of {scorecard.pricing.completedTotal} closed WOs — attendance not logged
                    </p>
                  )}
                </div>
              )}
            </ScorecardCard>

            {/* KPI 6 — Gross Margin on Closed Jobs
                Maloney FPRC: 3-stat row Avg GM% (+ goal badge) | GM vs Target | Total GP $. */}
            <ScorecardCard
              title="Gross Margin on Closed Jobs"
              kpiTag="KPI 6"
              tooltip="Opp Close Date CFY · WO End Date PFQ · Status Closed / Complete Paid in Full."
            >
              {scorecard.margin.avgGmPct === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No completed WOs with margin data in this period.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Avg GM%</div>
                    <div className={[
                      "font-condensed text-xl sm:text-2xl font-bold",
                      scorecard.margin.vsTarget !== null && scorecard.margin.vsTarget >= 0 ? "text-ppp-green-700" :
                      scorecard.margin.vsTarget !== null && scorecard.margin.vsTarget < -5 ? "text-ppp-orange-700" :
                      "text-ppp-navy",
                    ].join(" ")}>
                      {scorecard.margin.avgGmPct.toFixed(1)}%
                    </div>
                    <div className="text-[10px] text-ppp-charcoal-500">{scorecard.margin.completedCount} Closed WOs</div>
                    {scorecard.margin.target !== null && scorecard.margin.vsTarget !== null && (
                      <div className={[
                        "inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide",
                        scorecard.margin.vsTarget >= 0 ? "bg-ppp-green-50 text-ppp-green-700" : "bg-ppp-orange-50 text-ppp-orange-700",
                      ].join(" ")}>
                        Goal {scorecard.margin.target.toFixed(1)}% · {scorecard.margin.vsTarget >= 0 ? "Above" : "Below"}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">GM vs Target</div>
                    <div className={[
                      "font-condensed text-xl sm:text-2xl font-bold",
                      scorecard.margin.vsTarget === null ? "text-ppp-charcoal-200" :
                      scorecard.margin.vsTarget >= 0 ? "text-ppp-green-700" : "text-ppp-orange-700",
                    ].join(" ")}>
                      {scorecard.margin.vsTarget !== null
                        ? `${scorecard.margin.vsTarget >= 0 ? "+" : ""}${scorecard.margin.vsTarget.toFixed(1)}pp`
                        : "—"}
                    </div>
                    {scorecard.margin.target !== null && (
                      <div className="text-[10px] text-ppp-charcoal-500">Target {scorecard.margin.target.toFixed(1)}%</div>
                    )}
                    {scorecard.margin.target === null && (
                      <div className="text-[10px] text-ppp-charcoal-500 italic">No goal set</div>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Total GP $</div>
                    <div className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy" title={`$${Math.round(scorecard.margin.totalGpDollars).toLocaleString()}`}>
                      {fmtMoneyK(scorecard.margin.totalGpDollars / 1000)}
                    </div>
                  </div>
                </div>
              )}
            </ScorecardCard>

            {/* KPI 7 — Production Quality
                Full-width per Maloney FPRC PDF page 2. Gets the whole row so
                the 4-stat layout breathes. Reviews graceful with 0/0. */}
            <div className="lg:col-span-3">
            <ScorecardCard
              title="Production Quality"
              kpiTag="KPI 7"
              tooltip="Completed: Opp Close CFY · WO End PFQ. Sold: KPI1 won set. Reviews / Complaints: PFQ."
            >
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Comp / Sold</div>
                  <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy">
                    {scorecard.production.jobsCompleted} / {scorecard.production.oppsWon}
                  </div>
                  <div className="text-[10px] text-ppp-charcoal-500">
                    {scorecard.production.completionRatio !== null ? `${scorecard.production.completionRatio.toFixed(1)}% Ratio` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Change Orders</div>
                  <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-navy" title={`$${Math.round(scorecard.production.changeOrders).toLocaleString()}`}>
                    ${Math.round(scorecard.production.changeOrders).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Reviews</div>
                  {scorecard.production.goodReviews === 0 && scorecard.production.badReviews === 0 ? (
                    <div className="font-condensed text-2xl sm:text-3xl font-bold text-ppp-charcoal-300">—</div>
                  ) : (
                    <div className="font-condensed text-2xl sm:text-3xl font-bold">
                      <span className="text-ppp-green-700">+{scorecard.production.goodReviews}</span>
                      <span className="text-ppp-charcoal-400 mx-1">/</span>
                      <span className={scorecard.production.badReviews > 0 ? "text-ppp-orange-700" : "text-ppp-charcoal-300"}>-{scorecard.production.badReviews}</span>
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Complaints</div>
                  <div className={[
                    "font-condensed text-2xl sm:text-3xl font-bold",
                    scorecard.production.complaints > 0 ? "text-ppp-orange-700" : "text-ppp-navy",
                  ].join(" ")}>
                    {scorecard.production.complaints}
                  </div>
                </div>
              </div>
            </ScorecardCard>
            </div>

            {/* KPI 8 — Money Flow
                Spans 2 cols of the outer 3-col grid so the 4 stats have room
                to breathe instead of crashing into each other. Matches the
                Maloney FPRC page-2 layout (KPI 8 wider, KPI 9 narrower). */}
            <div className="lg:col-span-2">
            <ScorecardCard
              title="Money Flow"
              kpiTag="KPI 8"
              tooltip="Opp Close Date CFY, Transaction Date PFQ."
            >
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <FlowStat
                  label="Money Collected"
                  amount={scorecard.moneyFlow.moneyCollected}
                  countLabel={`${scorecard.moneyFlow.moneyCollectedCount} Payments received`}
                />
                <FlowStat
                  label="Labor Paid Out"
                  amount={scorecard.moneyFlow.laborPaidOut}
                  countLabel={`${scorecard.moneyFlow.laborPaidOutCount} Payouts`}
                />
                <FlowStat
                  label="Total Purchases"
                  amount={scorecard.moneyFlow.purchases}
                  countLabel={`${scorecard.moneyFlow.purchasesCount} Purchases`}
                />
                <FlowStat
                  label="Balance Owed"
                  amount={scorecard.moneyFlow.balanceOwed}
                  countLabel={`${scorecard.moneyFlow.balanceOwedCount} WOs in Complete Balance Owed`}
                  warnIfNonZero
                />
              </div>
            </ScorecardCard>
            </div>

            {/* KPI 9 — Commissions
                Maloney FPRC: 3-stat row Draw Received | Earned | Overpaid box.
                Overpaid renders as a NEGATIVE signed amount per the PDF
                (e.g. -$1,030 in red). */}
            <ScorecardCard
              title="Commissions"
              kpiTag="KPI 9"
              tooltip="Earned: Payment Out, Payee Type Sales, Date CFY."
            >
              {scorecard.commissions.earned === 0 && scorecard.commissions.drawReceived === null ? (
                <div className="space-y-2">
                  <div className="font-condensed text-3xl font-bold text-ppp-charcoal-200">—</div>
                  <p className="text-xs text-ppp-charcoal-500">
                    No commission Draw payouts (PayeeType=Sales) for this rep in this fiscal year.
                  </p>
                </div>
              ) : scorecard.commissions.drawReceived === null ? (
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Commissions Earned</div>
                  <div className="font-condensed text-3xl font-bold text-ppp-navy">
                    {fmtCommissionDollars(scorecard.commissions.earned)}
                  </div>
                  <p className="text-[10px] text-ppp-charcoal-500">
                    CFY-to-date · no Quarterly Draw set for this rep
                  </p>
                </div>
              ) : (
                (() => {
                  const draw = scorecard.commissions.drawReceived ?? 0;
                  const earned = scorecard.commissions.earned;
                  const diff = scorecard.commissions.difference ?? 0;
                  const overpaid = diff < 0;
                  const qtrAmt = scorecard.commissions.drawQuarterly;
                  const qInP = scorecard.commissions.quartersInPeriod;
                  return (
                    // Stacked vertical layout — KPI 9 lives in 1 col of the
                    // outer 3-col grid, no horizontal room for 3 sub-stats.
                    // Stacking gives every number room to render in full.
                    <div className="space-y-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Draw Received</div>
                          <div className="font-condensed text-xl font-bold text-ppp-navy" title={`$${Math.round(draw).toLocaleString()}`}>
                            {fmtCommissionDollars(draw)}
                          </div>
                          {qtrAmt !== null && qInP !== null && (
                            <div className="text-[10px] text-ppp-charcoal-500 leading-tight">
                              ${Math.round(qtrAmt).toLocaleString()}/qtr × {qInP}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500">Earned</div>
                          <div className="font-condensed text-xl font-bold text-ppp-navy" title={`$${Math.round(earned).toLocaleString()}`}>
                            {fmtCommissionDollars(earned)}
                          </div>
                          <div className="text-[10px] text-ppp-charcoal-500 leading-tight">
                            {scorecard.commissions.payoutCount} payouts
                          </div>
                        </div>
                      </div>
                      <div className={[
                        "rounded-lg px-3 py-2",
                        overpaid ? "bg-ppp-orange-50 border border-ppp-orange-100" : "bg-ppp-green-50 border border-ppp-green-100",
                      ].join(" ")}>
                        <div className="flex items-baseline justify-between gap-2 flex-wrap">
                          <span className={[
                            "text-[10px] uppercase tracking-wide font-semibold",
                            overpaid ? "text-ppp-orange-700" : "text-ppp-green-700",
                          ].join(" ")}>
                            {overpaid ? "Overpaid (Draw > Earned)" : "Net Earned"}
                          </span>
                          <span className={[
                            "font-condensed text-xl font-bold whitespace-nowrap",
                            overpaid ? "text-ppp-orange-700" : "text-ppp-green-700",
                          ].join(" ")} title={`$${Math.round(diff).toLocaleString()}`}>
                            {diff >= 0 ? "+" : "-"}${Math.abs(Math.round(diff)).toLocaleString()}
                          </span>
                        </div>
                        <div className={[
                          "text-[10px] mt-0.5",
                          overpaid ? "text-ppp-orange-700" : "text-ppp-green-700",
                        ].join(" ")}>
                          Earned − Draw
                        </div>
                      </div>
                    </div>
                  );
                })()
              )}
            </ScorecardCard>
          </div>

          {/* Attendance completeness — data-quality signal. When < 80%
              logged, this is a real warning: KPI 5 (Pricing / Rev per
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

      {/* ─── Recently Sent Quotes (open opps, by Estimate Sent date) ─── */}
      {recentlySentQuotes.length > 0 && (
        <section>
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-ppp-charcoal-100 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-ppp-charcoal">Recently Sent Quotes</h3>
                <p className="text-xs text-ppp-charcoal-500 mt-0.5">
                  Open opportunities with an estimate sent — most recent first
                </p>
              </div>
              <span className="text-[11px] font-medium text-ppp-blue-700 bg-ppp-blue-50 border border-ppp-blue-100 px-2 py-0.5 rounded-full">
                {recentlySentQuotes.length} quote{recentlySentQuotes.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="bg-ppp-charcoal-50 text-[11px] font-semibold tracking-wide text-ppp-charcoal-500 uppercase">
                  <tr>
                    <th className="text-left px-6 py-3">Customer</th>
                    <th className="text-left px-6 py-3">Stage</th>
                    <th className="text-right px-6 py-3">Quoted</th>
                    <th className="text-right px-6 py-3">Quote Sent</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {recentlySentQuotes.map((d) => (
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
                        {d.closedAt ?? `${d.daysInStage}d ago`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
              {recentlySentQuotes.map((d) => (
                <li key={d.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-ppp-charcoal truncate">
                        {d.customer}
                        <CustomerBadges acct={accountByName.get(d.customer)} />
                      </div>
                      <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">
                        Quote sent {d.closedAt ?? `${d.daysInStage}d ago`}
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

/**
 * 12-month revenue chart with prior-year overlay (Maloney FPRC KPI 1 style).
 * Light bars behind, dark bars in front. Pure SVG, no chart library.
 */
function RevenueYoyChart({ data }: {
  data: { monthLabel: string; monthShort: string; yearLabel: string; current: number; priorYear: number }[];
}) {
  if (data.length === 0) return null;
  const maxVal = Math.max(1, ...data.flatMap((d) => [d.current, d.priorYear]));
  // Scale to "nice" round 4-step ticks above the data max.
  const ticks = (() => {
    const niceMax = Math.ceil(maxVal / 10_000) * 10_000;
    return [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];
  })();
  const top = ticks[ticks.length - 1];
  const chartH = 140;
  const chartW = 100; // percent
  const barGroupW = chartW / data.length;
  const barW = (barGroupW * 0.38);
  return (
    <div className="mt-2">
      <div className="flex items-center gap-3 mb-1.5 text-[10px] text-ppp-charcoal-500">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-ppp-blue-200" />
          prior year
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-ppp-navy" />
          current year
        </span>
      </div>
      <div className="relative" style={{ height: `${chartH}px` }}>
        {/* Y-axis tick lines + labels */}
        <div className="absolute inset-0">
          {ticks.map((t, i) => {
            const y = chartH - (t / top) * chartH;
            return (
              <div
                key={i}
                className="absolute left-0 right-0 border-t border-ppp-charcoal-50"
                style={{ top: `${y}px` }}
              >
                <span className="absolute -top-2 -left-1 text-[9px] text-ppp-charcoal-400">
                  {t === 0 ? "$0" : `$${Math.round(t / 1000)}k`}
                </span>
              </div>
            );
          })}
        </div>
        {/* Bars */}
        <svg
          viewBox={`0 0 100 ${chartH}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full"
          style={{ height: `${chartH}px`, paddingLeft: 26 }}
        >
          {data.map((d, i) => {
            const cx = i * barGroupW + barGroupW * 0.5;
            const priorH = (d.priorYear / top) * chartH;
            const currH = (d.current / top) * chartH;
            return (
              <g key={i}>
                <rect
                  x={cx - barW * 1.05}
                  y={chartH - priorH}
                  width={barW}
                  height={priorH}
                  fill="#bfdbfe"
                  rx="0.6"
                >
                  <title>{`${d.monthLabel} (prior): $${Math.round(d.priorYear).toLocaleString()}`}</title>
                </rect>
                <rect
                  x={cx + barW * 0.05}
                  y={chartH - currH}
                  width={barW}
                  height={currH}
                  fill="#0a3d52"
                  rx="0.6"
                >
                  <title>{`${d.monthLabel} (current): $${Math.round(d.current).toLocaleString()}`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
      </div>
      {/* Month labels */}
      <div className="flex justify-between mt-1 pl-7 pr-1 text-[9px] text-ppp-charcoal-500">
        {data.map((d, i) => (
          <div key={i} className="flex flex-col items-center" style={{ width: `${barGroupW}%` }}>
            <span>{d.monthShort}</span>
            {/* Show year label only on Jan + first bucket — reduces visual noise */}
            {(d.monthShort === "Jan" || i === 0) && (
              <span className="text-ppp-charcoal-400">{d.yearLabel}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Money-Flow cell, Maloney FPRC style: stacked label / $ / count subtitle.
 *  $ shows rounded ($K) with full $ in the title tooltip on hover. */
function FlowStat({ label, amount, countLabel, warnIfNonZero = false }: {
  label: string;
  amount: number;
  countLabel: string;
  warnIfNonZero?: boolean;
}) {
  const fullDollar = `$${Math.round(amount).toLocaleString()}`;
  const color = warnIfNonZero && amount > 0 ? "text-ppp-orange-700" : "text-ppp-navy";
  // Rounded $K display for big amounts (≥ $100K) so the cell doesn't blow
  // out when KPI 8 lives in a narrow 4-col grid. Full $ stays in the tooltip.
  const display = amount === 0
    ? "$0"
    : Math.abs(amount) >= 100_000
      ? `$${Math.round(amount / 1000).toLocaleString()}K`
      : fullDollar;
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ppp-charcoal-500 leading-tight">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-bold ${color} truncate`} title={fullDollar}>
        {display}
      </div>
      <div className="text-[10px] text-ppp-charcoal-500 leading-tight">{countLabel}</div>
    </div>
  );
}

