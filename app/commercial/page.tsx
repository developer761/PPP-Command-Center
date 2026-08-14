/**
 * `/commercial` — Commercial Command Center landing.
 *
 * Money-first layout (Karan 2026-08), like the residential PPP dashboard —
 * the revenue headline sits on top, everything else below:
 *   1. Tomco logo strip
 *   2. REVENUE & P&L — gross (lifetime pre-tax billed, incl. closed jobs),
 *      job costs, net, margin + 6-month revenue trend + margin gauge, with a
 *      collapsible cost-breakdown / revenue-by-project drawer.
 *   3. AT A GLANCE — compact 6-up KPI strip (pipeline · open · wins · GCs ·
 *      contract · AR).
 *   4. NEEDS ATTENTION — only the categories that actually need action.
 *   5. UNDER CONTRACT — active-job billing (donut + tiles), over-billing
 *      surfaced in amber, never netted across deals.
 *   6. Top 5 open + Recent activity · Quick actions · Roadmap.
 *
 * Revenue scope note: the P&L rollup spans the WHOLE portfolio incl. closed
 * jobs (lifetime billed), while "Under contract" is scoped to active jobs — two
 * deliberately different scopes, each labeled. Reuses the opps/accounts/
 * invoices/projects list fetches; everything else is derived JS-side.
 */
import Link from "next/link";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import Image from "next/image";
import {
  derivedOppName,
  formatOpportunityNumber,
  listCommercialOpportunities,
  weightedPipelineCents,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import { listCurrentProposalByOpp } from "@/lib/commercial/proposals/db";
import { nextStep } from "@/lib/commercial/opportunities/attention";
import { NextStepButton } from "@/components/commercial/next-step-button";
import { isPostSaleProject, isLost, wasWonInPeriod, isOverdueProposal, isColdRfp, isFollowUpDue, PRE_SALE_OPEN_STATUSES } from "@/lib/commercial/opportunities/constants";
import { etTodayIso, etDateOf, daysFromTodayEt } from "@/lib/date-et";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus, BILLABLE_INVOICE_STATUSES } from "@/lib/commercial/invoices/constants";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { costBreakdownByOpp, emptyCostBreakdown } from "@/lib/commercial/purchases/db";
import { PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META } from "@/lib/commercial/purchases/constants";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import { monthlyBilledSeries } from "@/lib/commercial/invoices/monthly";
import { marginFrom } from "@/lib/commercial/projects/financials";
import TrendChart from "@/components/trend-chart";
import { DonutChart, HBars, StatCard, type ChartTone, type DonutSegment } from "@/components/commercial/charts";

const DASH_COST_TONE: Record<string, ChartTone> = {
  materials: "blue", labor: "brand", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};
// Field-ops crew labor (Option A) is a cost source alongside purchases; it gets
// its own donut slice so "where the money goes" shows in-house labor distinctly.
const CREW_LABOR_TONE: ChartTone = "emerald";

export const dynamic = "force-dynamic";


/** Days between two ISO dates (positive = a before b). Null-safe. */
function daysBetween(fromIso: string | null | undefined): number | null {
  // ET CALENDAR days, not a UTC subtraction. Two reasons the old math lied:
  // a DST week is 23 or 25 hours so the floor rounded a day away, and a bare
  // DATE ("2026-08-12") parses as UTC midnight, which is the 11th in Eastern.
  // etDateOf leaves date-only strings alone and zone-shifts real timestamps.
  const d = etDateOf(fromIso);
  if (!d) return null;
  return -daysFromTodayEt(d);
}

/** "3 days ago" / "in 2 weeks" / "today". */
function relativeLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const days = daysBetween(iso);
  if (days === null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days > 0) return `${days}d ago`;
  return `in ${-days}d`;
}

export default async function CommercialDashboardPage() {
  const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
  const [opps, accounts, invoices, projectRows, operatingCompany] = await Promise.all([
    listCommercialOpportunities({}),
    listCommercialAccounts({}),
    listCommercialInvoices({}),
    listProjects({}),
    getOperatingCompany(),
  ]);
  // Fallback deal value for deals with no bid range. The meeting removed Bid
  // low/high from both create forms (pricing lives on the proposal now), so
  // without this every deal created since then contributes ZERO to weighted
  // pipeline and drops off "Top 5 open opportunities" entirely — the number
  // Alex reads every morning would drift quietly low.
  // The fuller query — same round trip `listCurrentProposalTotalByOpp` was
  // already making under the hood, minus throwing the state away. Totals feed
  // weighted pipeline; the state feeds each row's next-step button.
  const currentProposalByOpp = await listCurrentProposalByOpp(opps.map((o) => o.id));
  const proposalTotalByOpp = new Map(
    Array.from(currentProposalByOpp, ([id, p]) => [id, p.totalCents] as const)
  );
  const oppWeighted = (o: CommercialOpportunity) =>
    weightedPipelineCents(o, proposalTotalByOpp.get(o.id));

  // ─── Production (post-contract) roll-up ───
  const production = summarizeProduction(projectRows);
  const completedPctOfContract =
    production.contractValueCents > 0
      ? Math.round((production.completedToDateCents / production.contractValueCents) * 100)
      : null;

  // An ARCHIVED (or deleted-parent) deal's invoices must drop out of the money
  // headlines exactly as they drop out of Gross/Net/Margin — those come from
  // listProjects, which filters archived_at, while the invoice list does not.
  // Without this, archiving a part-paid deal cut Gross by the billed amount but
  // left the same dollars in "Owed to us", the AR-aging tile, AND the revenue
  // trend, so margin recomputed against a smaller gross while the debt lingered
  // and the trend line sat ABOVE the gross it's meant to be a subset of (audit
  // D8). `opps` is every LIVE (non-archived, non-deleted) opportunity, fully
  // paginated; an invoice with no opportunity_id is account-level and unaffected
  // by deal archiving, so it stays.
  const liveOppIds = new Set(opps.map((o) => o.id));
  const liveInvoices = invoices.filter(
    (i) => i.opportunity_id == null || liveOppIds.has(i.opportunity_id)
  );

  // ─── AR ───
  // Real accounts-receivable = billed-and-unpaid only. Karan 2026-07-27:
  // exclude unsent DRAFTS (not owed until sent) + paid/void, so the headline
  // matches its sent/overdue drill-down. deriveInvoiceStatus resolves the
  // computed "overdue" state; BILLABLE = sent/viewed/partial/overdue.
  const arOutstandingCents = liveInvoices
    .filter((i) => BILLABLE_INVOICE_STATUSES.has(deriveInvoiceStatus(i)))
    // Clamp per invoice so a credit/overpaid invoice can't net down the AR —
    // one "Outstanding" definition platform-wide (matches the account rollup).
    .reduce((acc, i) => acc + Math.max(0, i.balance_cents), 0);
  const overdueInvoices = liveInvoices.filter((i) => deriveInvoiceStatus(i) === "overdue");
  const arOverdueCount = overdueInvoices.length;
  // The DOLLARS overdue (per-invoice clamped) — the number a CEO actually fears,
  // shown on the tile instead of a bare count (2026-08 CEO/AR UX walk).
  const arOverdueCents = overdueInvoices.reduce((acc, i) => acc + Math.max(0, i.balance_cents), 0);

  // ─── Opp buckets ───
  // "Open" = the PRE-SALE pipeline only (deals still being sold). Post-sale
  // stages (pre_construction/in_progress/billing) are under contract, covered by
  // the "Under contract" strip — including them here double-counted their
  // dollars in the weighted pipeline (audit L4).
  // Shared platform definition (PRE_SALE_OPEN_STATUSES) so the dashboard, the
  // pipeline list, and Account 360 all count the same deal once.
  const openOpps = opps.filter((o) => PRE_SALE_OPEN_STATUSES.includes(o.status));
  // "Won" = won at ANY stage (isPostSaleProject), so a won deal that advanced
  // into production still counts as a win (isWon alone missed those — audit H2).
  const wonOpps = opps.filter((o) => isPostSaleProject(o));
  const lostOpps = opps.filter((o) => isLost(o));
  // Win-rate basis: won + lost, EXCLUDING no-bids. We never quoted a no-bid, so
  // it says nothing about how we price or sell — the win/loss report excludes
  // them and this tile did not, which was one of three ways the two disagreed.
  const decidedOpps = [
    ...wonOpps,
    ...lostOpps.filter((o) => o.loss_reason !== "no_bid"),
  ];
  const weightedPipeline = openOpps.reduce((acc, o) => acc + oppWeighted(o), 0);

  // ─── This month ───
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  // decided_at is a DATE column ("2026-08-01"); compare it to a bare ET
  // month-start DATE — the full-ISO monthStart sorts AFTER "2026-08-01" and
  // silently drops every deal decided on the 1st.
  const monthStartDate = `${etTodayIso().slice(0, 7)}-01`;
  // M1: ONE definition of "won in this month" on BOTH halves of the rate. The
  // numerator used `wasWonInPeriod`, which skips a closed-out deal whose date
  // can't be trusted yet, while the denominator counted it anyway — so every
  // legacy closed-out job silently deflated the rate. Whatever the numerator
  // won't count, the denominator doesn't either.
  const wonThisMonth = wonOpps.filter((o) => wasWonInPeriod(o, monthStartDate));
  const countableThisMonth = decidedOpps.filter(
    (o) =>
      (isLost(o) && (o.decided_at ?? "") >= monthStartDate) ||
      wasWonInPeriod(o, monthStartDate)
  );
  const totalDecidedForMonth = countableThisMonth.length;
  const monthWinPct =
    totalDecidedForMonth > 0
      ? Math.round((wonThisMonth.length / totalDecidedForMonth) * 100)
      : null;
  // D1: the tile and the report it opens must cover the SAME period. The tile
  // is this month; the report defaults to the quarter, so tapping a "62% win"
  // tile used to land on a different number with nothing explaining the gap.
  // Carry the month through as an explicit range.
  const monthEndDate = (() => {
    const [y, m] = monthStartDate.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${monthStartDate.slice(0, 7)}-${String(last).padStart(2, "0")}`;
  })();
  const winLossMonthHref = `/commercial/reports/win-loss?from=${monthStartDate}&to=${monthEndDate}`;

  // ─── Momentum deltas (accurate, no snapshot needed) ───
  // "N new this week" from created_at — a real momentum signal for the
  // morning glance. We deliberately DON'T show a week-over-week pipeline-$
  // delta: that needs a historical state snapshot we don't keep, and a
  // faked one would mislead.
  const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const newThisWeek = openOpps.filter((o) => (o.created_at ?? "") >= weekAgoIso).length;
  // Wins vs the SAME point last month — compare month-to-date against last
  // month's first (equal) span of elapsed time, not the full prior month.
  // Otherwise early in a month the delta is almost always negative even
  // when pace is fine ("Jul 2: 1 vs 12"). Using elapsed-ms avoids day-of-
  // month overflow bugs (Jan 31 → Feb has no 31).
  const monthStartMs = new Date(monthStart).getTime();
  const elapsedThisMonthMs = Date.now() - monthStartMs;
  const lastMonthStartMs = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const lastMonthStartIso = new Date(lastMonthStartMs).toISOString();
  const lastMonthCutoffIso = new Date(lastMonthStartMs + elapsedThisMonthMs).toISOString();
  // decided_at is a DATE column — compare against DATE-only bounds (full ISO
  // would drop the 1st-of-month here too).
  const lastMonthStartDate = lastMonthStartIso.slice(0, 10);
  const lastMonthCutoffDate = lastMonthCutoffIso.slice(0, 10);
  const wonLastMonthToDate = wonOpps.filter(
    (o) =>
      (o.decided_at ?? "") >= lastMonthStartDate && (o.decided_at ?? "") < lastMonthCutoffDate
  ).length;
  const winsDelta = wonThisMonth.length - wonLastMonthToDate;

  // ─── NEEDS ATTENTION signals ───
  // One read of the ET calendar day for every needs-attention predicate below.
  const attentionToday = etTodayIso();
  // Overdue proposals: open opp, proposal_due_at is in the past, and
  // no proposal was ever sent (heuristic: status still in Proposal-*
  // or earlier). We approximate by counting any open opp whose
  // proposal_due_at is past-due.
  // Shared predicates (constants.ts) so the pipeline list this card links to
  // counts the SAME deals — they'd drifted on both the status set and the date
  // comparison, so "3 overdue" could open a list of 4.
  const overdueProposals = openOpps.filter((o) => isOverdueProposal(o, attentionToday));
  // Cold RFPs: RFP received > 7 days ago, deal still open. Signal
  // that we're sitting on a request without responding.
  const coldRfps = openOpps.filter((o) => isColdRfp(o, attentionToday));
  // Follow-ups due today or overdue: follow_up_at ≤ today.
  const followupsDue = openOpps.filter((o) => isFollowUpDue(o, attentionToday));
  // Wins awaiting debrief — D3: pre_sale_closed only, matching the count and
  // every filing surface. This listed won deals at any delivery stage, which no
  // screen can file a debrief for, so the list could never be worked to empty.
  const winsAwaitingDebrief = wonOpps.filter(
    (o) => o.status === "pre_sale_closed" && !o.win_loss_debriefed_at
  );

  // ─── TOP 5 OPEN DEALS by weighted value ───
  const accountNameById = new Map(accounts.map((a) => [a.id, a.company_name]));
  const topOpenDeals = openOpps
    .slice()
    .sort((a, b) => oppWeighted(b) - oppWeighted(a))
    .slice(0, 5);

  // ─── RECENT ACTIVITY (last 5 opps by updated_at) ───
  const recentOpps = opps
    .slice()
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 5);

  // ─── Revenue & P&L (whole Command Center — LIFETIME, incl. closed jobs) ───
  // Gross = pre-tax billed-to-date; Net = gross − job costs; Margin = net ÷ gross.
  // Scope spans EVERY project incl. post_sale_closed (a finished job's revenue
  // is still revenue), so the headline can't drop when a job closes and so the
  // still-reachable deal P&L (no status filter) stays a subset of this number
  // — deal ⊂ account ⊂ portfolio (2026-08 money audit #5 / regression #2). This
  // is a different, wider scope than the active-only "Under contract" strip.
  // allDeals:true so a PRE-SALE bid's costs (shown in its own reachable P&L) roll
  // into the portfolio too — otherwise deal ⊄ portfolio for pre-sale costs (#6).
  const allProjectRows = await listProjects({ includeClosed: true, allDeals: true });
  const allProjectOppIds = new Set(allProjectRows.map((p) => p.opp.id));
  const byOpp = await costBreakdownByOpp(allProjectRows.map((p) => p.opp.id));
  const costs = emptyCostBreakdown();
  for (const b of byOpp.values()) {
    for (const c of PURCHASE_CATEGORIES) costs[c] += b[c];
    costs.total += b.total;
  }
  // Field-ops crew labor (Option A) — the auto cost source. Each project row
  // already carries its labor (folded into p.costsCents), so summing the rows'
  // labor keeps the portfolio total identical to Σ per-deal P&L (deal ⊂
  // portfolio). totalCostCents = purchases + crew labor drives Net/Margin.
  const crewLaborCents = allProjectRows.reduce((acc, p) => acc + p.fieldOpsLaborCents, 0);
  const laborUnratedHours = allProjectRows.reduce((acc, p) => acc + p.laborUnratedHours, 0);
  const totalCostCents = costs.total + crewLaborCents;
  const grossRevenueCents = allProjectRows.reduce((acc, p) => acc + p.billedContractCents, 0);
  const netProfitCents = grossRevenueCents - totalCostCents;
  const revMarginPct = grossRevenueCents > 0 ? Math.round((netProfitCents / grossRevenueCents) * 100) : null;
  const revMarginTone: ChartTone = revMarginPct === null ? "neutral" : revMarginPct < 0 ? "rose" : revMarginPct < 15 ? "amber" : "emerald";
  // Monthly billed revenue ($K) — shared ET-bucketed, pre-tax, issued-only
  // helper scoped to the SAME project opps as the headline, so the trend is
  // always a subset of gross (never exceeds it) and buckets by ET like the rest
  // of the app.
  const revenueMonthly = monthlyBilledSeries(invoices, {
    months: 6,
    oppIds: allProjectOppIds,
    nowIso: new Date().toISOString(),
  });
  // This month vs last (billed, pre-tax) — the "how are we doing lately"
  // answer a CEO opens the app for. Values come straight off the trend's last
  // two buckets (which are $K), so they always agree with the chart.
  const thisMonthBilledCents = Math.round((revenueMonthly.at(-1)?.value ?? 0) * 100000);
  const lastMonthBilledCents = Math.round((revenueMonthly.at(-2)?.value ?? 0) * 100000);
  const momBilledDeltaPct =
    lastMonthBilledCents > 0
      ? Math.round(((thisMonthBilledCents - lastMonthBilledCents) / lastMonthBilledCents) * 100)
      : null;
  const revCostSegments: DonutSegment[] = [
    ...PURCHASE_CATEGORIES.filter((c) => costs[c] > 0).map((c) => ({
      label: PURCHASE_CATEGORY_META[c].label,
      value: costs[c],
      tone: DASH_COST_TONE[c] ?? "neutral",
      valueLabel: formatCentsCompact(costs[c]),
    })),
    ...(crewLaborCents > 0
      ? [{ label: "Crew labor", value: crewLaborCents, tone: CREW_LABOR_TONE, valueLabel: formatCentsCompact(crewLaborCents) }]
      : []),
  ];
  const revProjectBars = allProjectRows
    .filter((p) => p.billedContractCents > 0)
    .map((p) => {
      const gross = p.billedContractCents;
      const m = marginFrom(gross, p.costsCents);
      const net = m.cents;
      return {
        label: derivedOppName(p.opp, accountNameById.get(p.opp.account_id) ?? ""),
        value: gross,
        // Neutral while no costs are booked. The caption already says "no costs
        // logged", but a green bar says "healthy job" louder than the caption
        // says "we haven't spent anything yet".
        tone: (m.provisional ? "neutral" : net < 0 ? "rose" : "emerald") as ChartTone,
        valueLabel: formatCentsCompact(gross),
        sub: m.provisional ? "no costs logged" : `${formatCentsCompact(net)} net · ${m.pct ?? 0}%`,
        href: `/commercial/opportunities/${p.opp.id}`,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Tomco "home" strip — their logo greets them on their own dashboard.
          The logo JPG has a white background, so it sits in its own white chip
          (deliberate in both light + dark, instead of a bare white box on a
          dark card). */}
      <div className="flex items-center gap-3 sm:gap-4 bg-surface border border-ppp-charcoal-100 rounded-xl px-4 sm:px-5 py-2.5 shadow-sm">
        <span className="inline-flex items-center rounded-lg bg-white px-2 py-1 shrink-0">
          <Image
            // Served from the operating company, falling back to the bundled
            // file — so an uploaded logo actually shows here instead of only on
            // the PDFs, and the picture agrees with the name beside it.
            src={operatingCompany.logo_asset_key ? "/api/commercial/operating-company/logo" : "/brand/tomco-logo.jpg"}
            alt={operatingCompany.name}
            unoptimized={!!operatingCompany.logo_asset_key}
            width={268}
            height={131}
            priority
            className="h-8 sm:h-9 w-auto"
          />
        </span>
        <div className="min-w-0 border-l border-ppp-charcoal-100 pl-3 sm:pl-4">
          <h1 className="text-sm font-semibold text-ppp-charcoal leading-tight">Welcome back</h1>
          {/* From the operating-company record, not a literal. A rename or a
              licensee updated every generated document and left the name over
              the CEO's own dashboard unchanged. */}
          <div className="text-[11px] text-ppp-charcoal-500 leading-tight">{operatingCompany.name} · Command Center</div>
        </div>
      </div>

      {/* ═══ Revenue & P&L — the money headline, on top (whole Command Center) ═══ */}
      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Are we making money?
          <span className="text-[11px] font-medium text-ppp-charcoal-500">— whole company · every deal</span>
        </h2>
        {/* Calm zero-state on a brand-new workspace — one line, not four "$0"
            tiles + a flat chart that read as "is this broken?" (2026-08 first-run
            walk). */}
        {(grossRevenueCents > 0 || allProjectRows.length > 0 || totalCostCents > 0) ? (
        <>
        {/* Lead with the "are we making money" answer: Net profit + Margin
            first & biggest; Gross (only-goes-up) demoted; Job costs last. Plain
            subs, no formulas (2026-08 CEO UX walk). */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Net profit" value={`${netProfitCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(netProfitCents))}`} tone={netProfitCents < 0 ? "rose" : "emerald"} sub="after job costs" />
          <StatCard label="Margin" value={revMarginPct === null ? "—" : `${revMarginPct}%`} tone={revMarginTone} sub={revMarginPct === null ? "no revenue yet" : revMarginPct < 0 ? "losing money" : revMarginPct < 15 ? "thin" : "healthy"} />
          <StatCard label="Gross revenue" value={formatCentsCompact(grossRevenueCents)} tone="brand" sub="billed to date" spark={revenueMonthly.map((r) => r.value)} sparkLabels={revenueMonthly.map((r) => r.label)} />
          <StatCard label="Job costs" value={formatCentsCompact(totalCostCents)} tone="amber" sub={totalCostCents === 0 ? "none logged" : crewLaborCents > 0 ? "materials · crew · subs" : "materials · subs"} />
        </div>
        <div className="mt-3 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
            <h3 className="text-[13px] font-bold text-ppp-charcoal">Revenue billed</h3>
            <div className="flex items-baseline gap-2 text-[11.5px] tabular-nums">
              <span className="text-ppp-charcoal-500">This month <span className="font-bold text-ppp-charcoal">{formatCentsCompact(thisMonthBilledCents)}</span></span>
              {momBilledDeltaPct !== null && momBilledDeltaPct !== 0 && (
                <span className={`inline-flex items-center gap-0.5 font-bold ${momBilledDeltaPct > 0 ? "text-emerald-700" : "text-rose-600"}`}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={momBilledDeltaPct > 0 ? "" : "rotate-180"}><path d="M12 19V5 M5 12l7-7 7 7" /></svg>
                  {Math.abs(momBilledDeltaPct)}% vs last
                </span>
              )}
            </div>
          </div>
          <TrendChart data={revenueMonthly} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[150px] sm:h-[180px]" />
        </div>
        <details className="group/rev mt-3">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] select-none">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/rev:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
            Cost breakdown &amp; revenue by project
          </summary>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3">Where the money goes</h3>
              {revCostSegments.length > 0 ? (
                <DonutChart size={144} segments={revCostSegments} centerValue={formatCentsCompact(totalCostCents)} centerLabel="job costs" />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-500 py-6 text-center">No job costs logged yet. Add them on any deal&rsquo;s Transactions tab.</p>
              )}
              {laborUnratedHours > 0 && (
                <p className="mt-3 text-[11.5px] text-amber-700 leading-snug">
                  <span className="font-semibold">{laborUnratedHours.toLocaleString()} crew hours</span> have no cost rate set, so labor cost (and profit) is understated. Set rates on the <Link href="/commercial/field-ops/employees" className="font-semibold underline">Crew</Link> page.
                </p>
              )}
            </div>
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-[13px] font-bold text-ppp-charcoal">Revenue by project</h3>
                <Link href="/commercial/opportunities?lane=under_contract" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Under contract →</Link>
              </div>
              {revProjectBars.length > 0 ? (
                <HBars items={revProjectBars} />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-500 py-6 text-center">No billed revenue yet.</p>
              )}
            </div>
          </div>
        </details>
        </>
        ) : (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 text-center shadow-sm">
            <p className="text-[13px] text-ppp-charcoal-500">No revenue yet — win and bill your first job to see profit &amp; margin here.</p>
            <Link href="/commercial/opportunities" className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px]">Go to the pipeline →</Link>
          </div>
        )}
      </section>

      {/* ─── At a glance — compact KPI strip (pipeline · wins · GCs · contract · AR) ─── */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <DashStat label="Pipeline" value={formatCentsCompact(weightedPipeline)} sub="expected value" tone="blue" href="/commercial/opportunities" delta={newThisWeek > 0 ? { value: newThisWeek, suffix: " new" } : null} />
        <DashStat label="Open" value={openOpps.length.toLocaleString()} sub="opportunities" tone="navy" href="/commercial/opportunities" />
        <DashStat label="Wins · mo" value={wonThisMonth.length.toLocaleString()} sub={monthWinPct !== null ? `${monthWinPct}% win` : "this month"} tone="emerald" href={winLossMonthHref} delta={winsDelta !== 0 ? { value: winsDelta, suffix: " vs last" } : null} />
        <DashStat label="Active GCs" value={accounts.length.toLocaleString()} sub="general contractors" tone="blue" href="/commercial/accounts" />
        <DashStat label="Under contract" value={production.activeProjects > 0 ? formatCentsCompact(production.contractValueCents) : "—"} sub={production.activeProjects > 0 ? `${production.activeProjects} active` : "no jobs yet"} tone="navy" href="/commercial/opportunities?lane=under_contract" />
        <DashStat label="Owed to us" value={formatCentsCompact(arOutstandingCents)} sub={arOverdueCount > 0 ? `${formatCentsCompact(arOverdueCents)} overdue` : "all current"} tone={arOverdueCount > 0 ? "rose" : "blue"} href={arOverdueCount > 0 ? "/commercial/reports/ar-aging" : "/commercial/reports/ar-aging"} />
      </section>

      {/* ─── NEEDS ATTENTION strip ─── */}
      {/* Only surface the categories that ACTUALLY need attention — an
          "attention" section full of "All clear" boxes is noise and buries the
          one real item (Karan 2026-07-25). When nothing needs attention the
          whole section is hidden (the KPI strip below already shows the calm
          state). */}
      {(() => {
        const attentionItems = [
          overdueProposals.length > 0 && {
            key: "overdue",
            count: overdueProposals.length,
            label: "Overdue proposals",
            sub: overdueProposals.length === 1 ? "1 bid past its due date" : `${overdueProposals.length} bids past due date`,
            href: "/commercial/opportunities?overdue=1",
            tone: "rose" as const,
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6 M12 16.5v.5" />
              </svg>
            ),
          },
          coldRfps.length > 0 && {
            key: "cold",
            count: coldRfps.length,
            label: "Cold RFPs (>7d)",
            sub: coldRfps.length === 1 ? "1 sitting on the bid request" : `${coldRfps.length} sitting on the bid request`,
            href: "/commercial/opportunities?coldrfp=1",
            tone: "amber" as const,
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 2v6a6 6 0 0 0 12 0V2 M6 22v-6a6 6 0 0 1 12 0v6 M4 2h16 M4 22h16" />
              </svg>
            ),
          },
          followupsDue.length > 0 && {
            key: "followup",
            count: followupsDue.length,
            label: "Follow-ups due",
            sub: followupsDue.length === 1 ? "1 to check in on today" : `${followupsDue.length} to check in on today`,
            href: "/commercial/opportunities?followup=1",
            tone: "navy" as const,
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 8v4l3 3" />
                <circle cx="12" cy="12" r="10" />
              </svg>
            ),
          },
          winsAwaitingDebrief.length > 0 && {
            key: "debrief",
            count: winsAwaitingDebrief.length,
            label: "Awaiting debrief",
            sub: winsAwaitingDebrief.length === 1 ? "1 won opportunity needs a debrief" : `${winsAwaitingDebrief.length} won opportunities need a debrief`,
            href: "/commercial/reports/win-loss",
            tone: "emerald" as const,
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            ),
          },
        ].filter(Boolean) as Array<{
          key: string; count: number; label: string; sub: string; href: string;
          tone: "rose" | "amber" | "navy" | "emerald"; icon: React.ReactNode;
        }>;
        if (attentionItems.length === 0) return null;
        return (
          <section>
            <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
              <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
              Needs your attention
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-cc-brand-600 text-white text-[10px] font-bold tabular-nums">
                {attentionItems.length}
              </span>
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {attentionItems.map((it) => (
                <AttentionCard
                  key={it.key}
                  count={it.count}
                  label={it.label}
                  sub={it.sub}
                  href={it.href}
                  tone={it.tone}
                  icon={it.icon}
                />
              ))}
            </div>
          </section>
        );
      })()}

      {/* ─── UNDER CONTRACT (production) ─── */}
      {/* Only surface once there's at least one job under contract — an all-zero
          production strip is noise before the first Won job (matches the
          attention-strip discipline). */}
      {production.activeProjects > 0 && (
        <section>
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Under contract
            <span className="text-[11px] font-medium text-ppp-charcoal-500">
              — {production.activeProjects} active {production.activeProjects === 1 ? "project" : "projects"}
              {production.inProductionProjects > 0 ? ` · ${production.inProductionProjects} in production` : ""}
            </span>
            <Link href="/commercial/opportunities?lane=under_contract" className="ml-auto text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">
              All projects →
            </Link>
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm flex items-center justify-center">
              {/* Split the billed bar into within-contract (emerald) + over-contract
                  (amber) so an over-billed job shows an amber wedge past the
                  contract ring instead of a clean full-green "done" — the amber +
                  center=contract makes the overage visible, not hidden. */}
              <DonutChart
                size={128}
                segments={[
                  { label: production.overBilledCents > 0 ? "Within contract" : "Billed", value: production.billedContractCents - production.overBilledCents, tone: "emerald", valueLabel: formatCentsCompact(production.billedContractCents - production.overBilledCents) },
                  { label: "Left to bill", value: production.leftToBillCents, tone: "blue", valueLabel: formatCentsCompact(production.leftToBillCents) },
                  ...(production.overBilledCents > 0
                    ? [{ label: "Over-billed", value: production.overBilledCents, tone: "amber" as ChartTone, valueLabel: formatCentsCompact(production.overBilledCents) }]
                    : []),
                ]}
                centerValue={formatCentsCompact(production.contractValueCents)}
                centerLabel="contract"
              />
            </div>
            <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <DashStat label="Contract" value={formatCentsCompact(production.contractValueCents)} sub={completedPctOfContract !== null ? `${completedPctOfContract}% complete` : "incl. COs"} tone="navy" href="/commercial/opportunities?lane=under_contract" />
              <DashStat
                label="Billed"
                value={formatCentsCompact(production.billedContractCents)}
                sub={
                  production.overBilledCents > 0
                    ? `${formatCentsCompact(production.overBilledCents)} over on ${production.overBilledProjects} ${production.overBilledProjects === 1 ? "job" : "jobs"}`
                    : production.invoicedCents > 0
                      ? `${Math.round((production.paidCents / production.invoicedCents) * 100)}% collected`
                      : "pre-tax contract billed"
                }
                tone={production.overBilledCents > 0 ? "amber" : "emerald"}
                href="/commercial/opportunities?lane=under_contract"
              />
              <DashStat label="Left to bill" value={formatCentsCompact(production.leftToBillCents)} sub="contract − billed" tone="blue" href="/commercial/opportunities?lane=under_contract" />
              <DashStat label="Outstanding" value={formatCentsCompact(production.outstandingCents)} sub={production.pendingCoCount > 0 ? `${production.pendingCoCount} CO pending` : "open on active jobs"} tone={production.outstandingCents > 0 ? "amber" : "blue"} href="/commercial/opportunities?lane=under_contract" />
            </div>
          </div>
        </section>
      )}

      {/* ─── Two-column: Top 5 open + Recent activity ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TopOpenDealsCard opps={topOpenDeals} accountNameById={accountNameById} proposalTotalByOpp={proposalTotalByOpp} currentProposalByOpp={currentProposalByOpp} />
        <RecentActivityCard opps={recentOpps} accountNameById={accountNameById} />
      </section>

      {/* ─── Quick actions ─── */}
      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Quick actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <QuickAction
            primary
            href={`/commercial/accounts?status_error=${encodeURIComponent("Pick the general contractor first — opportunities live under the GC.")}`}
            title="Start a bid"
            sub="Pick a GC to log the opportunity under."
            icon={<IconPlus />}
          />
          <QuickAction
            href="/commercial/accounts/new"
            title="Add general contractor"
            sub="Create a new commercial GC account."
            icon={<IconBuilding />}
          />
          <QuickAction
            href="/commercial/opportunities"
            title="Pipeline board"
            sub="Drag opportunities through stages."
            icon={<IconKanban />}
          />
          <QuickAction
            href="/commercial/reports/win-loss"
            title="Win/Loss report"
            sub="Quarterly debrief numbers."
            icon={<IconChart />}
          />
        </div>
      </section>

    </div>
  );
}

// ─────────────── Compact dashboard stat cell ───────────────

function DashStat({
  label,
  value,
  sub,
  tone = "neutral",
  href,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "blue" | "emerald" | "amber" | "rose" | "navy";
  href?: string;
  delta?: { value: number; suffix?: string } | null;
}) {
  const dot =
    tone === "emerald" ? "bg-emerald-500"
    : tone === "rose" ? "bg-rose-500"
    : tone === "amber" ? "bg-amber-500"
    : tone === "blue" ? "bg-ppp-blue-500"
    : tone === "navy" ? "bg-ppp-navy-500"
    : "bg-ppp-charcoal-300";
  const valueCls =
    tone === "rose" ? "text-rose-700" : tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : "text-ppp-charcoal";
  const inner = (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate">{label}</span>
      </div>
      <div className={`font-condensed text-xl sm:text-2xl font-black leading-none tabular-nums mt-1 ${valueCls}`}>{value}</div>
      <div className="mt-0.5 flex items-center gap-1 flex-wrap">
        {sub && <span className="text-[10px] text-ppp-charcoal-500 leading-tight">{sub}</span>}
        {delta && delta.value !== 0 && (
          <span className={`inline-flex items-center gap-0.5 text-[9.5px] font-bold ${delta.value > 0 ? "text-emerald-700" : "text-ppp-charcoal-500"}`}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={delta.value > 0 ? "" : "rotate-180"}><path d="M12 19V5 M5 12l7-7 7 7" /></svg>
            {delta.value > 0 ? "+" : ""}{delta.value}{delta.suffix ?? ""}
          </span>
        )}
      </div>
    </>
  );
  const cls = "block bg-surface border border-ppp-charcoal-100 rounded-lg px-3 py-2.5 min-h-[44px] transition-all";
  return href ? (
    <Link href={href} className={`${cls} hover:border-ppp-charcoal-200 hover:shadow-sm touch-manipulation`}>{inner}</Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

// ─────────────── Attention card ───────────────

function AttentionCard({
  count,
  label,
  sub,
  href,
  tone,
  icon,
}: {
  count: number;
  label: string;
  sub: string;
  href: string;
  tone: "rose" | "amber" | "cc-brand" | "emerald" | "navy";
  icon: React.ReactNode;
}) {
  // Only rendered when count > 0 — the "Needs attention" section filters out
  // clear categories entirely, so there's no zero/all-clear state here.
  const ring =
    tone === "rose"
      ? "border-rose-200 bg-rose-50/40 hover:border-rose-400 hover:bg-rose-50/70"
      : tone === "amber"
      ? "border-amber-200 bg-amber-50/40 hover:border-amber-400 hover:bg-amber-50/70"
      : tone === "cc-brand"
      ? "border-cc-brand-200 bg-cc-brand-50/40 hover:border-cc-brand-400 hover:bg-cc-brand-50/70"
      : tone === "navy"
      ? "border-ppp-navy-100 bg-ppp-navy-50/40 hover:border-ppp-navy-300 hover:bg-ppp-navy-50/70"
      : "border-emerald-200 bg-emerald-50/40 hover:border-emerald-400 hover:bg-emerald-50/70";
  const numberCls =
    tone === "rose"
      ? "text-rose-700"
      : tone === "amber"
      ? "text-amber-700"
      : tone === "cc-brand"
      ? "text-cc-brand-700"
      : tone === "navy"
      ? "text-ppp-navy-700"
      : "text-emerald-700";
  const iconCls =
    tone === "rose"
      ? "bg-rose-100 text-rose-700"
      : tone === "amber"
      ? "bg-amber-100 text-amber-700"
      : tone === "cc-brand"
      ? "bg-cc-brand-100 text-cc-brand-700"
      : tone === "navy"
      ? "bg-ppp-navy-100 text-ppp-navy-700"
      : "bg-emerald-100 text-emerald-700";
  return (
    <Link
      href={href}
      className={`group/att relative block border rounded-xl px-4 py-3 min-h-[92px] transition-all hover:shadow-md touch-manipulation ${ring}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          {label}
        </span>
        <span aria-hidden className={`inline-flex items-center justify-center h-7 w-7 rounded-lg ${iconCls}`}>
          {icon}
        </span>
      </div>
      <div className={`font-condensed text-3xl font-black leading-none tracking-tight tabular-nums ${numberCls}`}>
        {count}
      </div>
      <div className="mt-1 text-[11px] text-ppp-charcoal-500 leading-snug">
        {sub}
      </div>
    </Link>
  );
}

// ─────────────── Top 5 open opportunities ───────────────

function TopOpenDealsCard({
  opps,
  accountNameById,
  proposalTotalByOpp,
  currentProposalByOpp,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
  /** Without it a bid-less deal shows "$0" in a list sorted by that number. */
  proposalTotalByOpp: Map<string, number>;
  /** Newest live proposal per deal — what lets a row say "mark it approved". */
  currentProposalByOpp: Map<string, { id: string; status: string }>;
}) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
      {/* No overflow clipping on this card: the next-step won/lost popover
          opens out of flow and a clipping card cuts it off. */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100 rounded-t-xl">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Top 5 open opportunities
        </h3>
        <Link
          href="/commercial/opportunities"
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1 -mr-1"
        >
          Full pipeline →
        </Link>
      </header>
      {opps.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-ppp-charcoal-500">
          Nothing open. Log your next bid to see it here.
        </div>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-100">
          {opps.map((o, idx) => {
            const acct = accountNameById.get(o.account_id) ?? null;
            const display = derivedOppName(o, acct);
            const weighted = weightedPipelineCents(o, proposalTotalByOpp.get(o.id));
            const oppCode = formatOpportunityNumber(o.project_number);
            const cp = currentProposalByOpp.get(o.id) ?? null;
            const next = nextStep({
              oppId: o.id,
              status: o.status,
              subStatus: o.sub_status,
              accountId: o.account_id,
              proposal: cp ? { id: cp.id, status: cp.status } : null,
              proposalCount: cp ? 1 : 0,
              sentProposalCount: cp && ["sent", "won", "lost"].includes(cp.status) ? 1 : 0,
              approvedNotSentCount: 0,
            });
            return (
              // The button sits OUTSIDE the row's <Link> — an anchor inside an
              // anchor is invalid and the inner one stops firing. It wraps to
              // its own line on a phone rather than crushing the money column.
              <li key={o.id} className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:pr-3">
                <Link
                  // D5: a deal-click opens the DEAL. These used to land on the
                  // opportunities tab with an edit sheet auto-popped — a form
                  // nobody asked for, in front of the thing they wanted to read.
                  href={`/commercial/opportunities/${o.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] hover:bg-ppp-charcoal-50/60 touch-manipulation flex-1 min-w-0"
                >
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-100 text-cc-brand-700 text-[11px] font-bold tabular-nums shrink-0">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                      {display}
                    </div>
                    <div className="text-[10.5px] text-ppp-charcoal-500 truncate flex items-center gap-1.5 mt-0.5">
                      {oppCode && <span className="font-mono text-ppp-navy-600">{oppCode}</span>}
                      {oppCode && <span aria-hidden>·</span>}
                      <span>{oppStatusDisplayLabel(o.status, o.sub_status)}</span>
                      {o.proposal_due_at && (
                        <>
                          <span aria-hidden>·</span>
                          <span>Due {relativeLabel(o.proposal_due_at)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[12.5px] font-bold text-ppp-charcoal tabular-nums">
                      {formatCentsCompact(weighted)}
                    </div>
                    <div className="text-[9.5px] text-ppp-charcoal-500 uppercase tracking-wider">
                      weighted
                    </div>
                  </div>
                </Link>
                <NextStepButton step={next} oppId={o.id} className="mb-2.5 ml-4 sm:mb-0 sm:ml-0" />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ─────────────── Recent activity ───────────────

function RecentActivityCard({
  opps,
  accountNameById,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
}) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Recent activity
        </h3>
        <Link
          href="/commercial/opportunities?sort=updated"
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1 -mr-1"
        >
          All opportunities →
        </Link>
      </header>
      {opps.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-ppp-charcoal-500">
          No opportunities yet. Start your first bid to see activity here.
        </div>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-100">
          {opps.map((o) => {
            const acct = accountNameById.get(o.account_id) ?? null;
            const display = derivedOppName(o, acct);
            const oppCode = formatOpportunityNumber(o.project_number);
            const relative = relativeLabel(o.updated_at);
            return (
              <li key={o.id}>
                <Link
                  href={`/commercial/opportunities/${o.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] hover:bg-ppp-charcoal-50/60 touch-manipulation"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                      {display}
                    </div>
                    <div className="text-[10.5px] text-ppp-charcoal-500 truncate flex items-center gap-1.5 mt-0.5">
                      {oppCode && <span className="font-mono text-ppp-navy-600">{oppCode}</span>}
                      {oppCode && <span aria-hidden>·</span>}
                      <span>{oppStatusDisplayLabel(o.status, o.sub_status)}</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 shrink-0 tabular-nums whitespace-nowrap">
                    {relative}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ─────────────── Reusable tiles ───────────────

function QuickAction({
  primary,
  href,
  title,
  sub,
  icon,
}: {
  primary?: boolean;
  href: string;
  title: string;
  sub: string;
  icon: React.ReactNode;
}) {
  const shell = primary
    ? "group/qa bg-gradient-to-br from-cc-brand-100/40 via-surface to-surface border-cc-brand-200 text-ppp-charcoal hover:border-cc-brand-400 shadow-sm shadow-cc-brand-100/40 relative overflow-hidden"
    : "group/qa bg-surface border-ppp-charcoal-100 text-ppp-charcoal hover:border-cc-brand-300 shadow-sm relative overflow-hidden";
  const iconCls = primary
    ? "bg-gradient-to-br from-cc-brand-500 to-cc-brand-600 text-white shadow-md shadow-cc-brand-200 group-hover/qa:from-cc-brand-600 group-hover/qa:to-cc-brand-700"
    : "bg-gradient-to-br from-cc-brand-100 to-cc-brand-50 text-cc-brand-700 group-hover/qa:from-cc-brand-600 group-hover/qa:to-cc-brand-500 group-hover/qa:text-white group-hover/qa:shadow-md group-hover/qa:shadow-cc-brand-200";
  return (
    <Link
      href={href}
      className={`block border rounded-xl px-4 py-4 transition-all hover:shadow-lg hover:-translate-y-0.5 touch-manipulation ${shell}`}
    >
      {primary ? (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400" />
      ) : null}
      <span aria-hidden className={`pointer-events-none absolute -top-8 -right-8 w-24 h-24 rounded-full blur-2xl opacity-70 ${primary ? "bg-cc-brand-100/60" : "bg-cc-brand-50/60 group-hover/qa:bg-cc-brand-100/70"}`} />
      <div className={`relative ${primary ? "pl-1" : ""}`}>
        <span aria-hidden className={`inline-flex items-center justify-center h-11 w-11 rounded-xl mb-3 transition-all ${iconCls}`}>
          {icon}
        </span>
        <div className="text-sm font-bold leading-tight tracking-tight flex items-center gap-1.5">
          {title}
          <span aria-hidden className="text-cc-brand-400 opacity-0 group-hover/qa:opacity-100 group-hover/qa:translate-x-1 transition-all">→</span>
        </div>
        <div className="mt-1 text-[12px] leading-snug text-ppp-charcoal-500">{sub}</div>
      </div>
    </Link>
  );
}

// ─────────────── Icons ───────────────

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18 M7 14l4-4 4 4 5-5" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4 M8 6h2 M14 6h2 M8 10h2 M14 10h2 M8 14h2 M14 14h2" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14 M5 12h14" />
    </svg>
  );
}
function IconKanban() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="12" rx="1" />
    </svg>
  );
}
