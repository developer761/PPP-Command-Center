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
import type { ReactNode } from "react";
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
import { marginFrom } from "@/lib/commercial/projects/financials";
import TrendChart from "@/components/trend-chart";
import { DonutChart, HBars, StatCard, type ChartTone, type DonutSegment } from "@/components/commercial/charts";
import { daysPastDue } from "@/lib/commercial/reports/ar-aging";
import { listAllWorkOrders } from "@/lib/commercial/work-orders/db";
import { rankJobsInFlight } from "@/lib/commercial/reports/jobs-in-flight";
import { JobsInFlight } from "@/components/commercial/jobs-in-flight";
import { buildWorklist, worklistTotals } from "@/lib/commercial/worklist";
import { companyPnl } from "@/lib/commercial/reports/company-pnl";
import { Worklist, WorklistClear } from "@/components/commercial/worklist";
import { PAYROLL_HREF } from "@/lib/commercial/field-ops/unrated-hours-note";
import { IN_DELIVERY_STATUSES } from "@/lib/commercial/opportunities/constants";
import { hadHeadToHead } from "@/lib/commercial/win-loss/reports";
import {
  DASHBOARD_PRESETS, DASHBOARD_DEFAULT, dashboardRange, priorDashboardRange,
  resolvePreset, validYmd, fiscalYearStartMonth,
} from "@/lib/commercial/reports/presets";
import { loadPeriodBilling, monthlyPointsFor } from "@/lib/commercial/reports/period-billing";
import { fieldOpsLaborByOpp } from "@/lib/commercial/field-ops/labor-cost";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { dashboardMetricNotes, type MetricKey } from "@/lib/commercial/dashboard/metric-notes";
import { MetricInfo } from "@/components/commercial/metric-info";
import { DashboardPeriodBar } from "@/components/commercial/dashboard-period-bar";

const DASH_COST_TONE: Record<string, ChartTone> = {
  materials: "blue", labor: "brand", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};
// Field-ops crew labor (Option A) is a cost source alongside purchases; it gets
// its own donut slice so "where the money goes" shows in-house labor distinctly.
const CREW_LABOR_TONE: ChartTone = "emerald";

export const metadata = { title: "Commercial" };

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

export default async function CommercialDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ONE clock read for the whole render. There were four, and they are all
  // comparisons against today: four separate reads can straddle midnight
  // mid-render and put a row in two different aging buckets on one screen.
  const nowMs = Date.now();
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
  //
  // ── EVERY READ THIS PAGE MAKES, IN ONE WAVE ──────────────────────────────
  //
  // This is the landing page — the one Alex opens every morning — and it ran
  // its reads in SIX sequential waves: the report folders, then the five
  // headline lists, then the archived deals, then the full project rows, then
  // the cost roll-up, then the work orders. Only two of those genuinely
  // depended on anything: the proposal map needs `opps`, and the cost
  // breakdown needs `allProjectRows`. The other four waves were ordered by
  // nothing but the order they were written in, and each one is a round trip
  // measured at 78ms median from a laptop.
  //
  // Two waves now. Nothing here writes, so nothing depends on the ordering.
  const [
    reportAccess,
    opps,
    accounts,
    invoices,
    projectRows,
    operatingCompany,
    archivedOpps,
    allProjectRows,
    liveWorkOrders,
    fyStartMonth,
    receivables,
  ] = await Promise.all([
    // Report folders: the dashboard links into AR aging and Win/Loss. Someone
    // outside those folders gets the number without a link that would bounce
    // them. The /commercial layout has already required a signed-in user.
    (async () => {
      const { createClient } = await import("@/lib/supabase/server");
      const { getReportAccess } = await import("@/lib/commercial/reports/access");
      const { data: { user } } = await (await createClient()).auth.getUser();
      return user ? getReportAccess(user.id, user.email) : null;
    })(),
    listCommercialOpportunities({}),
    listCommercialAccounts({}),
    listCommercialInvoices({}),
    listProjects({}),
    getOperatingCompany(),
    // Archived deals: a deal that legitimately exists but was tidied out of
    // the pipeline. See the note further down on why they stay in the books.
    listCommercialOpportunities({ onlyArchived: true }),
    // The WIDER project scope — deal ⊂ account ⊂ portfolio. `allDeals` so a
    // pre-sale bid's costs roll into the portfolio too.
    listProjects({ includeClosed: true, allDeals: true }),
    // Work-order state per job, loaded rather than inferred (Brendan
    // 2026-08-26).
    listAllWorkOrders().catch(() => []),
    // The fiscal year the period picker counts in (PPP: February).
    fiscalYearStartMonth(),
    // "Owed to us" IS the Receivables report's total — one definition of
    // what is owed, so the tile and the report it stands for cannot disagree.
    getReceivablesReport(nowMs),
  ]);

  // ─── THE PERIOD (Katie 2026-10-15, for Alex) ───
  // One window for every ACTIVITY figure on the page; balances stay "as of
  // today". A custom range with a missing or impossible date falls back to the
  // default, and the picker says so by showing the default as selected.
  const todayEt = etTodayIso();
  const askedPreset = resolvePreset(one("period"), DASHBOARD_PRESETS, DASHBOARD_DEFAULT);
  const customFrom = validYmd(one("from")) ?? "";
  const customTo = validYmd(one("to")) ?? "";
  const preset = askedPreset === "custom" && !(customFrom && customTo) ? DASHBOARD_DEFAULT : askedPreset;
  const range = dashboardRange(preset, fyStartMonth, todayEt, { from: customFrom, to: customTo });
  const priorRange = priorDashboardRange(preset, fyStartMonth, todayEt);
  const notes = dashboardMetricNotes(range ? range.label : "All time");
  const info = (key: MetricKey, label: string) => (
    <MetricInfo label={label} note={notes[key].text} scope={notes[key].scope} />
  );
  const periodPresets = DASHBOARD_PRESETS.map((p) => ({
    ...p,
    href:
      p.key === "custom"
        ? `/commercial?period=custom${customFrom && customTo ? `&from=${customFrom}&to=${customTo}` : ""}`
        : p.key === DASHBOARD_DEFAULT
          ? "/commercial"
          : `/commercial?period=${p.key}`,
  }));
  const canOpenArAging = !!reportAccess?.visible.has("ar-aging");
  const canOpenWinLoss = !!reportAccess?.visible.has("win-loss");
  // Fallback deal value for deals with no bid range. The meeting removed Bid
  // low/high from both create forms (pricing lives on the proposal now), so
  // without this every deal created since then contributes ZERO to weighted
  // pipeline and drops off "Top 5 open opportunities" entirely — the number
  // Alex reads every morning would drift quietly low.
  // The fuller query — same round trip `listCurrentProposalTotalByOpp` was
  // already making under the hood, minus throwing the state away. Totals feed
  // weighted pipeline; the state feeds each row's next-step button.
  //
  // WAVE 2 — the only two reads with a real dependency. The proposal map needs
  // `opps`; the cost breakdown needs `allProjectRows`. Both come from the wave
  // above, and neither needs the other, so they go together.
  //
  // The three PERIOD reads join it: billing, purchases and crew labor, each
  // limited to the picked window (`range` null = all time).
  const allProjectIds = allProjectRows.map((p) => p.opp.id);
  const [currentProposalByOpp, byOpp, periodBilling, periodLaborByOpp] = await Promise.all([
    listCurrentProposalByOpp(opps.map((o) => o.id)),
    costBreakdownByOpp(allProjectIds, range),
    loadPeriodBilling(allProjectIds, invoices, range),
    fieldOpsLaborByOpp(allProjectIds, range),
  ]);
  const proposalTotalByOpp = new Map(
    Array.from(currentProposalByOpp, ([id, p]) => [id, p.totalCents] as const)
  );

  /** Bids sitting in the approval queue — see the "Awaiting approval" tile. */
  const awaitingApprovalCount = Array.from(currentProposalByOpp.values()).filter(
    (p) => p.status === "pending_approval",
  ).length;
  const oppWeighted = (o: CommercialOpportunity) =>
    weightedPipelineCents(o, proposalTotalByOpp.get(o.id));

  // ─── Production (post-contract) roll-up ───
  const production = summarizeProduction(projectRows);
  // "% billed", NOT "% complete".
  //
  // This used `completedToDateCents`, which is the latest AIA application's
  // completed-and-stored figure — and is therefore ZERO on every job billed by
  // invoice. Dividing an AIA-only numerator by the WHOLE portfolio's contract
  // value meant a book that mostly bills by invoice reported a few percent
  // complete while being most of the way through its work.
  //
  // `billedContractCents` counts both ledgers, pre-tax, against a pre-tax
  // contract — the same basis as "Billed of contract" on Projects and Account
  // 360, so the three now agree. Renamed too: outside AIA there is no
  // completion measure, only billing, and claiming otherwise is what made the
  // number look authoritative while being wrong.
  const billedPctOfContract =
    production.contractValueCents > 0
      ? Math.min(100, Math.round((production.billedContractCents / production.contractValueCents) * 100))
      : null;

  // ─── AR ───
  // Real accounts-receivable = billed-and-unpaid only. Karan 2026-07-27:
  // exclude unsent DRAFTS (not owed until sent) + paid/void, so the headline
  // matches its sent/overdue drill-down. deriveInvoiceStatus resolves the
  // computed "overdue" state; BILLABLE = sent/viewed/partial/overdue.
  //
  // ARCHIVED deals stay IN. An earlier pass (audit D8) filtered them out to
  // stop archiving a part-paid deal from cutting Gross while the same dollars
  // lingered in "Owed to us" — but the AR-aging report this tile LINKS TO never
  // had that filter, so the tile read $0 and the page one click away read
  // $40,000. Of the two, the report is right: archiving is an organizational
  // action, voiding is the write-off, and money the GC still owes cannot
  // silently leave the collections book because someone tidied the pipeline.
  // Gross/Net/Margin stay live-only — they measure performance, not debt — and
  // the divergence is now stated on the tile instead of hidden by dropping it.
  // ...but a deal whose ACCOUNT was soft-deleted still drops out — that's a
  // deletion, not a tidy-up. Archived + live = every opp that legitimately
  // exists; anything else is orphaned. Account-less invoices are account-level
  // and unaffected either way.
  // `archivedOpps` is fetched in the single wave at the top.
  const realOppIds = new Set([...opps.map((o) => o.id), ...archivedOpps.map((o) => o.id)]);
  const billableInvoices = invoices.filter(
    (i) =>
      BILLABLE_INVOICE_STATUSES.has(deriveInvoiceStatus(i)) &&
      (i.opportunity_id == null || realOppIds.has(i.opportunity_id))
  );
  // Overdue invoices feed the worklist's "Chase what they owe" rows.
  const overdueInvoices = billableInvoices.filter((i) => deriveInvoiceStatus(i) === "overdue");

  /**
   * "OWED TO US" = THE RECEIVABLES REPORT'S TOTAL (Katie 2026-10-15).
   *
   * This tile used to run its own arithmetic — sent/partial/overdue invoice
   * balances plus AIA due now on ACTIVE jobs only, retention excluded — while
   * the Receivables report one click away counted retention, AIA on closed and
   * archived jobs, and (until today) won-but-unbilled drafts. Alex had three
   * "owed" figures on two screens and none matched Mary's sheet.
   *
   * Now there is one rule, and it lives in `getReceivablesReport`: billed and
   * unpaid (sent invoices + issued AIA applications, net of retention) plus
   * retention held, shown separately; nothing that has not been billed. This
   * tile reads that total, so it cannot drift from the report again.
   */
  const arOutstandingCents = receivables.totalOpenCents;
  const arRetentionCents = receivables.retainageCents;
  const arOverdueCents = receivables.overdueCents;
  const arNoDueDateCents = receivables.noDueDateCents;

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
  // Win-rate basis: won + lost, EXCLUDING no-bids (see `lostIn` below). We
  // never quoted a no-bid, so it says nothing about how we price or sell.
  const weightedPipeline = openOpps.reduce((acc, o) => acc + oppWeighted(o), 0);

  // ─── Wins in the period ───
  // Was "this month" only. Now the picked range, with ONE predicate for both
  // halves of the rate and for the delta (`wasWonInPeriod`). The old "vs last"
  // compared against raw `decided_at` on UTC month bounds, so it counted legacy
  // closed-out jobs the month figure deliberately skips and could shift a day
  // at the month edge.
  //
  // All time: every won deal is a win, whatever its date — the date guard in
  // `wasWonInPeriod` exists to put a win in the right MONTH, and with no window
  // there is no month to get wrong.
  const wonIn = (r: { fromYmd: string; toYmd: string } | null) =>
    r ? wonOpps.filter((o) => wasWonInPeriod(o, r.fromYmd, r.toYmd)) : wonOpps;
  const lostIn = (r: { fromYmd: string; toYmd: string } | null) =>
    lostOpps.filter((o) => {
      if (o.loss_reason === "no_bid") return false;
      if (!r) return true;
      const d = (o.decided_at ?? "").slice(0, 10);
      return d >= r.fromYmd && d <= r.toYmd;
    });
  const wonThisPeriod = wonIn(range);
  const lostThisPeriod = lostIn(range).length;
  /**
   * A win rate needs something to have been lost — a period with wins and no
   * losses on record is not "100%", it is the absence of a measurement
   * (Tomco's migration brought 92 won jobs and no lost bids). Same predicate as
   * the Win/Loss report, from the same module, so they cannot drift.
   */
  const periodWinPct = hadHeadToHead({ wonCount: wonThisPeriod.length, lostCount: lostThisPeriod })
    ? Math.round((wonThisPeriod.length / (wonThisPeriod.length + lostThisPeriod)) * 100)
    : null;
  // D1: the tile and the report it opens cover the SAME period.
  const winLossHref = range
    ? `/commercial/reports/win-loss?from=${range.fromYmd}&to=${range.toYmd}`
    : "/commercial/reports/win-loss";

  // ─── Momentum ───
  // "N new this week" from created_at — a real momentum signal for the
  // morning glance, deliberately NOT tied to the picker. We don't show a
  // pipeline-$ delta: that needs a historical snapshot we don't keep.
  const weekAgoIso = new Date(nowMs - 7 * 86_400_000).toISOString();
  const newThisWeek = openOpps.filter((o) => (o.created_at ?? "") >= weekAgoIso).length;
  // Wins vs the previous period at the same point (`priorDashboardRange`).
  const winsDelta = priorRange ? wonThisPeriod.length - wonIn(priorRange).length : 0;

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

  const accountNameById = new Map(accounts.map((a) => [a.id, a.company_name]));

  // ─── THE WORKLIST ───
  // Everything above is a figure. This is the part you can act on, built from
  // the same reads — no extra queries — and ranked by money at risk.
  const oppById = new Map(opps.map((o) => [o.id, o]));
  const nameOf = (o: CommercialOpportunity) => derivedOppName(o, accountNameById.get(o.account_id) ?? "");
  /*
   * OVERDUE AIA BELONGS ON THE CHASE LIST TOO.
   *
   * "Owed to us" counts overdue AIA; this list did not, so the tile said chase
   * $X and the list of whom to chase was short. It stopped being academic on
   * 2026-10-15: once AR aging stopped dating back-entered certificates from the
   * day they were typed, $29,275.70 of genuinely overdue AIA appeared that
   * nobody would have been told to collect.
   *
   * Taken from the receivables report — the same single definition the tile
   * reads — rather than computed again here, which is how the two drifted
   * apart in the first place. Retention is excluded: it is held to close-out,
   * not late, and `daysOut` is null on those rows.
   */
  const overdueAia = receivables.rows.filter((r) => r.kind === "aia" && (r.daysOut ?? 0) > 0);
  const worklistItems = buildWorklist({
    overdueInvoices: [
      ...overdueAia.map((r) => ({
        id: r.sourceId,
        number: r.reference,
        accountId: r.accountId,
        accountName: r.accountName,
        balanceCents: Math.max(0, r.openCents),
        daysLate: r.daysOut ?? 0,
        href: r.href,
      })),
      ...overdueInvoices.map((i) => ({
      id: i.id,
      number: i.invoice_number,
      accountId: i.account_id,
      accountName:
        accountNameById.get(i.account_id) ??
        (i.opportunity_id ? nameOf(oppById.get(i.opportunity_id) ?? ({} as CommercialOpportunity)) : "") ??
        "Unassigned account",
      balanceCents: Math.max(0, i.balance_cents),
      daysLate: daysPastDue(i.due_at, nowMs),
      })),
    ],
    // Work that is finished and still not billed. Scoped to `billing` — a job
    // mid-production legitimately has money left to bill and putting it here
    // would fill the list with things nobody can act on today.
    unbilled: projectRows
      .filter((r) => r.opp.status === "billing" && r.leftToBillCents > 0)
      .map((r) => ({ oppId: r.opp.id, name: nameOf(r.opp), cents: r.leftToBillCents })),
    overdueProposals: overdueProposals.map((o) => ({
      oppId: o.id,
      name: nameOf(o),
      daysLate: o.proposal_due_at ? -daysFromTodayEt(o.proposal_due_at) : 0,
      cents: oppWeighted(o),
    })),
    coldRfps: coldRfps.map((o) => ({
      oppId: o.id,
      name: nameOf(o),
      daysWaiting: o.rfp_received_at ? -daysFromTodayEt(o.rfp_received_at) : 0,
    })),
    followUps: followupsDue.map((o) => ({
      oppId: o.id,
      name: nameOf(o),
      daysLate: o.follow_up_at ? -daysFromTodayEt(o.follow_up_at) : 0,
    })),
    awaitingDebrief: canOpenWinLoss
      ? winsAwaitingDebrief.map((o) => ({ oppId: o.id, name: nameOf(o) }))
      : [],
    // The one delivery gap that costs money rather than tidiness: a job being
    // delivered with no contract value on it. Every figure that job touches —
    // left-to-bill, margin, the production donut — is computed from zero, so it
    // quietly understates the book until somebody fills it in.
    jobGaps: projectRows
      .filter((r) => r.baseContractCents === 0 && (r.opp.status === "in_progress" || r.opp.status === "billing"))
      .map((r) => ({
        oppId: r.opp.id,
        name: nameOf(r.opp),
        title: "Put the contract value on it",
        consequence: "being delivered with no contract value — its margin and left-to-bill read zero",
        href: `/commercial/opportunities/${r.opp.id}?tab=project`,
      })),
  });
  const worklistAtRisk = worklistTotals(worklistItems).atRiskCents;

  // ─── TOP 5 OPEN DEALS by weighted value ───
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
  // `allProjectRows` is fetched in the single wave at the top.
  // `byOpp` is fetched in wave 2 at the top.
  const costs = emptyCostBreakdown();
  for (const b of byOpp.values()) {
    for (const c of PURCHASE_CATEGORIES) costs[c] += b[c];
    costs.total += b.total;
  }
  // Field-ops crew labor (Option A) — the auto cost source. Each project row
  // already carries its labor (folded into p.costsCents), so summing the rows'
  // labor keeps the portfolio total identical to Σ per-deal P&L (deal ⊂
  // portfolio). totalCostCents = purchases + crew labor drives Net/Margin.
  // Through the shared calculator, not inline: Alex's recurring email carries
  // the same four figures, and two places doing this arithmetic is how the
  // platform ends up saying 62% on screen and 58% in his inbox.
  //
  // PERIOD-SCOPED (2026-10-15): the same calculator, fed each job's billing and
  // crew labor INSIDE the picked window instead of its lifetime figures. Over
  // "All time" the inputs equal the project rows' own (see period-billing.ts),
  // so the lifetime view is unchanged.
  const periodPnlRows = allProjectRows.map((p) => {
    const labor = periodLaborByOpp.get(p.opp.id);
    return {
      billedContractCents: periodBilling.byOpp.get(p.opp.id) ?? 0,
      fieldOpsLaborCents: labor?.cents ?? 0,
      laborUnratedHours: labor?.unratedHours ?? 0,
    };
  });
  const pnl = companyPnl({ projects: periodPnlRows, purchaseCostCents: costs.total });
  const crewLaborCents = pnl.crewLaborCents;
  const laborUnratedHours = pnl.unratedHours;
  const totalCostCents = pnl.totalCostCents;
  const grossRevenueCents = pnl.grossRevenueCents;

  // Brendan 2026-08-26: "under 'this month' it should say things specific to
  // the deals." Everything above is a company aggregate; this is the same money
  // cut by job, with the one fact each job still owes. Work-order state is the
  // fact he named, so it is loaded here rather than inferred.
  // `liveWorkOrders` is fetched in the single wave at the top.
  const woByOpp = new Map<string, { sent: boolean }>();
  for (const w of liveWorkOrders) {
    const prev = woByOpp.get(w.opportunity_id);
    // A job can carry several sheets (migration 123). It counts as sent once
    // ANY of them has gone out — chasing a second, later sheet is not what this
    // row is for.
    woByOpp.set(w.opportunity_id, { sent: (prev?.sent ?? false) || !!w.sent_at });
  }
  const jobsInFlight = rankJobsInFlight(
    allProjectRows
      /**
       * WON AND WORKING — not everything that isn't finished.
       *
       * This excluded only `post_sale_closed`, so every open BID was a "job
       * in flight". AVR-Lot C sat at the top of Alex's dashboard at $386k,
       * 0% billed, flagged "no work order" — it is a proposal nobody has
       * accepted yet, so of course it has no work order and of course nothing
       * is billed. And because flagged rows sort FIRST, the panel led with
       * three un-won bids wearing problems they cannot have.
       *
       * IN_DELIVERY_STATUSES is the existing answer to "won and under
       * contract, not yet closed", and constants.ts says those three sets
       * partition every status with no overlap and no gap. Finished jobs stay
       * out, and still count in the revenue totals above, which is why those
       * load with includeClosed.
       */
      .filter((p) => IN_DELIVERY_STATUSES.includes(p.opp.status))
      .map((p) => {
        const wo = woByOpp.get(p.opp.id);
        return {
          oppId: p.opp.id,
          name: derivedOppName(p.opp, accountNameById.get(p.opp.account_id) ?? ""),
          accountName: p.accountName,
          billedCents: p.billedContractCents,
          contractCents: p.contractToDateCents,
          workOrderMissing: !wo,
          workOrderUnsent: !!wo && !wo.sent,
          outstandingCents: p.outstandingCents,
          overBilledCents: Math.max(0, p.billedContractCents - p.contractToDateCents),
        };
      })
  );
  const netProfitCents = pnl.netProfitCents;
  const revMarginPct = pnl.marginPct;
  const revMarginTone: ChartTone = revMarginPct === null ? "neutral" : revMarginPct < 0 ? "rose" : revMarginPct < 15 ? "amber" : "emerald";
  // Monthly billed revenue ($K) — shared ET-bucketed, pre-tax, issued-only
  // helper scoped to the SAME project opps as the headline, so the trend is
  // always a subset of gross (never exceeds it) and buckets by ET like the rest
  // of the app.
  //
  // Both ledgers now (invoices by SENT date + AIA by billing period), from the same
  // fold as Gross — a job billed only through AIA used to raise Gross and never
  // appear here. Months span the picked range, padded to at least six.
  const revenueMonthly = monthlyPointsFor(periodBilling.monthly, range, todayEt);
  // This month vs last (billed, pre-tax) — the "how are we doing lately"
  // answer a CEO opens the app for. Read from the monthly map directly, not the
  // chart's last two bars: a "Last FY" chart ends in January.
  const monthKey = (offset: number) => {
    const y = Number(todayEt.slice(0, 4));
    const m = Number(todayEt.slice(5, 7)) - 1 + offset;
    const yy = y + Math.floor(m / 12);
    return `${yy}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`;
  };
  const thisMonthBilledCents = periodBilling.monthly.get(monthKey(0)) ?? 0;
  const lastMonthBilledCents = periodBilling.monthly.get(monthKey(-1)) ?? 0;
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
  // In the picked window: each job's billing and its costs (purchases + crew
  // labor) inside the same dates, so a job's net here is that period's net.
  const revProjectBars = allProjectRows
    .map((p) => ({
      p,
      gross: periodBilling.byOpp.get(p.opp.id) ?? 0,
      costCents: (byOpp.get(p.opp.id)?.total ?? 0) + (periodLaborByOpp.get(p.opp.id)?.cents ?? 0),
    }))
    .filter(({ gross }) => gross > 0)
    .map(({ p, gross, costCents }) => {
      const m = marginFrom(gross, costCents);
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

      {/* ═══ Period picker — drives the activity figures below ═══ */}
      <DashboardPeriodBar
        active={preset}
        presets={periodPresets}
        resolved={range}
        custom={{ from: customFrom, to: customTo }}
      />

      {/* ═══ Revenue & P&L — the money headline, on top (whole Command Center) ═══ */}
      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Are we making money?
          <span className="text-[11px] font-medium text-ppp-charcoal-500">— whole company · {range ? range.label : "all time"}</span>
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
          <StatCard label="Net profit" value={`${netProfitCents < 0 ? "−" : ""}${formatCentsCompact(Math.abs(netProfitCents))}`} tone={netProfitCents < 0 ? "rose" : "emerald"} sub="after job costs" info={info("netProfit", "Net profit")} />
          <StatCard label="Margin" value={revMarginPct === null ? "—" : `${revMarginPct}%`} tone={revMarginTone} sub={revMarginPct === null ? "no revenue yet" : revMarginPct < 0 ? "losing money" : revMarginPct < 15 ? "thin" : "healthy"} info={info("margin", "Margin")} />
          <StatCard label="Gross revenue" value={formatCentsCompact(grossRevenueCents)} tone="brand" sub={range ? "billed in period" : "billed to date"} spark={revenueMonthly.map((r) => r.value)} sparkLabels={revenueMonthly.map((r) => r.label)} info={info("grossRevenue", "Gross revenue")} />
          <StatCard label="Job costs" value={formatCentsCompact(totalCostCents)} tone="amber" sub={totalCostCents === 0 ? "none logged" : crewLaborCents > 0 ? "materials · labor · crew" : "materials · labor"} info={info("jobCosts", "Job costs")} />
        </div>
        <div className="mt-3 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
            <h3 className="text-[13px] font-bold text-ppp-charcoal inline-flex items-center gap-1.5">Revenue billed{info("revenueChart", "Revenue billed")}</h3>
            <div className="flex items-baseline gap-2 text-[11.5px] tabular-nums">
              <span className="text-ppp-charcoal-500">This month <span className="font-bold text-ppp-charcoal">{formatCentsCompact(thisMonthBilledCents)}</span></span>
              {momBilledDeltaPct !== null && momBilledDeltaPct !== 0 && (
                <span className={`inline-flex items-center gap-0.5 font-bold ${momBilledDeltaPct > 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={momBilledDeltaPct > 0 ? "" : "rotate-180"}><path d="M12 19V5 M5 12l7-7 7 7" /></svg>
                  {Math.abs(momBilledDeltaPct)}% vs last
                </span>
              )}
            </div>
          </div>
          <TrendChart data={revenueMonthly} yFormat="currency-k" colorToken="cc-brand-500" area heightClassName="h-[150px] sm:h-[180px]" />
        </div>

        {/* Directly under "This month" — where Brendan asked for it. */}
        <JobsInFlight jobs={jobsInFlight} info={info("jobsInFlight", "Jobs in flight")} />
        <details className="group/rev mt-3">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[12px] font-semibold text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px] select-none">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open/rev:rotate-90"><path d="M9 18l6-6-6-6" /></svg>
            Cost breakdown &amp; revenue by project
          </summary>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3 inline-flex items-center gap-1.5">Where the money goes{info("costBreakdown", "Where the money goes")}</h3>
              {revCostSegments.length > 0 ? (
                <DonutChart size={144} segments={revCostSegments} centerValue={formatCentsCompact(totalCostCents)} centerLabel="job costs" />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-500 py-6 text-center">No job costs logged yet. Add them on any opportunity&rsquo;s Transactions tab.</p>
              )}
              {laborUnratedHours > 0 && (
                <p className="mt-3 text-[11.5px] text-amber-700 leading-snug">
                  <span className="font-semibold">{laborUnratedHours.toLocaleString()} crew hours</span> have no cost against them yet, so labor cost (and profit) reads high. They get their cost when the week is posted in <Link href={PAYROLL_HREF} className="font-semibold underline">Payroll</Link>.
                </p>
              )}
            </div>
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-[13px] font-bold text-ppp-charcoal inline-flex items-center gap-1.5">Revenue by project{info("revenueByProject", "Revenue by project")}</h3>
                <Link href="/commercial/opportunities?lane=under_contract" className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center px-1">Under contract →</Link>
              </div>
              {revProjectBars.length > 0 ? (
                <HBars items={revProjectBars} />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-500 py-6 text-center">{range ? "Nothing billed in this period." : "No billed revenue yet."}</p>
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

      {/* ─── At a glance ───
          Five, not six. "Under contract" was here AND as the headline of the
          Under-contract section a screen below, printing the same figure twice
          on one page — which is what Karan meant by "these KPIs are just the
          same ones over and over". The section below owns it: it can show
          contract, billed and left-to-bill together, which a single tile can't.
          Five tiles also divide cleanly at every breakpoint, where six left an
          orphan on the three-up. */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <DashStat label="Pipeline" value={formatCentsCompact(weightedPipeline)} sub="expected value" tone="blue" href="/commercial/opportunities" delta={newThisWeek > 0 ? { value: newThisWeek, suffix: " new" } : null} info={info("pipeline", "Pipeline")} />
        <DashStat label="Open" value={openOpps.length.toLocaleString()} sub="opportunities" tone="navy" href="/commercial/opportunities" info={info("open", "Open")} />
        <DashStat label="Wins" value={wonThisPeriod.length.toLocaleString()} sub={periodWinPct !== null ? `${periodWinPct}% win` : wonThisPeriod.length > 0 ? "none lost on record" : range ? range.label : "all time"} tone="emerald" href={canOpenWinLoss ? winLossHref : undefined} delta={winsDelta !== 0 ? { value: winsDelta, suffix: " vs last" } : null} info={info("wins", "Wins")} />
        {/* Brendan 2026-09-23: "dashboard add pending bids for approval."
            A bid sitting in the approval queue is the one thing on this page
            nobody else will chase — the estimator has done their part and is
            waiting, and the GC is waiting on both of them. Counted from the
            CURRENT proposal per deal, so a superseded revision left in that
            state cannot inflate it. */}
        <DashStat
          label="Awaiting approval"
          value={awaitingApprovalCount.toLocaleString()}
          sub={awaitingApprovalCount === 0 ? "nothing waiting" : awaitingApprovalCount === 1 ? "bid to approve" : "bids to approve"}
          tone={awaitingApprovalCount > 0 ? "amber" : "navy"}
          href="/commercial/proposals?status=pending_approval"
          info={info("awaitingApproval", "Awaiting approval")}
        />
        <DashStat label="Active GCs" value={accounts.filter((a) => !a.do_not_bid).length.toLocaleString()} sub="general contractors" tone="blue" href="/commercial/accounts" info={info("activeGcs", "Active GCs")} />
        <DashStat
          label="Owed to us"
          value={formatCentsCompact(arOutstandingCents)}
          sub={
            arOutstandingCents === 0
              ? "nothing outstanding"
              : [
                  arOverdueCents > 0
                    ? `${formatCentsCompact(arOverdueCents)} overdue`
                    : arNoDueDateCents > 0
                      ? // Cannot be "none overdue" when some of it has no date
                        // to be late against.
                        `${formatCentsCompact(arNoDueDateCents)} no due date`
                      : null,
                  // Retention is IN the total and named, so it can be told
                  // apart from money that is collectible now.
                  arRetentionCents > 0 ? `${formatCentsCompact(arRetentionCents)} retention` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "billed and unpaid, none overdue"
          }
          tone={arOverdueCents > 0 ? "rose" : arNoDueDateCents > 0 ? "amber" : "blue"}
          // The Receivables report is the one this total IS; AR aging buckets
          // the same book by lateness. Prefer the former when it's visible.
          href={reportAccess?.visible.has("receivables") ? "/commercial/reports/receivables" : canOpenArAging ? "/commercial/reports/ar-aging" : undefined}
          info={info("owedToUs", "Owed to us")}
        />
      </section>

      {/* ─── WHAT NEEDS DOING ───
          Was four cards reading "3 Overdue proposals", "2 Cold RFPs".

          Karan: the Overview shows figures, not what needs doing, and "these
          KPIs are just the same ones over and over."

          A count is not a task. It gives you a number and then asks you to go
          and find out WHICH ones — which is the work — so the strip got read as
          a status light and nothing moved. It was sales-only too: none of the
          money Mary chases and none of the delivery work reached the page the
          owner opens every morning.

          Now: the things themselves, named, ranked by money at risk, each
          linking to the surface that does it. Built from the reads this page
          already makes. */}
      {worklistItems.length > 0 ? (
        <Worklist items={worklistItems} shown={8} atRiskCents={worklistAtRisk} info={info("worklist", "What needs doing")} />
      ) : (
        <WorklistClear />
      )}

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
              <DashStat label="Contract" value={formatCentsCompact(production.contractValueCents)} sub={billedPctOfContract !== null ? `${billedPctOfContract}% billed` : "incl. COs"} tone="navy" href="/commercial/opportunities?lane=under_contract" info={info("contract", "Contract")} />
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
                info={info("billed", "Billed")}
              />
              <DashStat label="Left to bill" value={formatCentsCompact(production.leftToBillCents)} sub="contract − billed" tone="blue" href="/commercial/opportunities?lane=under_contract" info={info("leftToBill", "Left to bill")} />
              {/* Active jobs only, AIA folded in — distinct from "Owed to us"
                  above (whole book, invoice ledger). */}
              <DashStat label="Open · active jobs" value={formatCentsCompact(production.outstandingCents)} sub={production.pendingCoCount > 0 ? `${production.pendingCoCount} CO pending` : "unpaid, incl. AIA"} tone={production.outstandingCents > 0 ? "amber" : "blue"} href="/commercial/opportunities?lane=under_contract" info={info("openActiveJobs", "Open · active jobs")} />
            </div>
          </div>
        </section>
      )}

      {/* ─── Two-column: Top 5 open + Recent activity ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TopOpenDealsCard opps={topOpenDeals} accountNameById={accountNameById} proposalTotalByOpp={proposalTotalByOpp} currentProposalByOpp={currentProposalByOpp} info={info("topOpen", "Top 5 open opportunities")} />
        <RecentActivityCard opps={recentOpps} accountNameById={accountNameById} info={info("recentActivity", "Recent activity")} />
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
            href="/commercial/opportunities?new_deal=1#new-deal-sheet"
            title="Start a bid"
            sub="New opportunity — pick or add the GC as you go."
            icon={<IconPlus />}
          />
          <QuickAction
            href="/commercial/accounts/new"
            title="Add a GC"
            sub="Create a new general-contractor account."
            icon={<IconBuilding />}
          />
          {canOpenWinLoss && (
            <QuickAction
              href="/commercial/reports/win-loss"
              title="Win / Loss"
              sub="Win rate and why opportunities were lost."
              icon={<IconChart />}
            />
          )}
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
  info,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "blue" | "emerald" | "amber" | "rose" | "navy";
  href?: string;
  delta?: { value: number; suffix?: string } | null;
  /** The ⓘ, pinned top-right OUTSIDE the link (a button inside an <a> is
   *  invalid, and its tap would navigate instead of explaining). */
  info?: ReactNode;
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
        <span className={`text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500 truncate ${info ? "pr-6" : ""}`}>{label}</span>
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
  const tile = href ? (
    <Link href={href} className={`${cls} hover:border-ppp-charcoal-200 hover:shadow-sm touch-manipulation`}>{inner}</Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
  if (!info) return tile;
  return (
    <div className="relative">
      {tile}
      <div className="absolute top-2 right-2">{info}</div>
    </div>
  );
}


// ─────────────── Top 5 open opportunities ───────────────

function TopOpenDealsCard({
  opps,
  accountNameById,
  proposalTotalByOpp,
  currentProposalByOpp,
  info,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
  /** Without it a bid-less deal shows "$0" in a list sorted by that number. */
  proposalTotalByOpp: Map<string, number>;
  /** Newest live proposal per deal — what lets a row say "mark it approved". */
  currentProposalByOpp: Map<string, { id: string; status: string }>;
  info?: ReactNode;
}) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
      {/* No overflow clipping on this card: the next-step won/lost popover
          opens out of flow and a clipping card cuts it off. */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100 rounded-t-xl">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Top 5 open opportunities
          {info}
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
  info,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
  info?: ReactNode;
}) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Recent activity
          {info}
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