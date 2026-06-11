/**
 * Per-rep KPI scorecard — derived from a SalesforceSnapshot.
 *
 * Implements all 9 KPIs from PPP's REP_PERFORMANCE_KPIS.md (the spec PPP staff
 * already read in their FPRC reports). Pure functions, no SF calls.
 *
 * Period model: fiscal-aware. Pass either a fiscal year (+ optional quarter)
 * — recommended for matching PPP's reports — or a raw {start, end} range.
 *
 *   deriveRepScorecard(snapshot, repId, { fy: 2026, q: 3 })
 *   deriveRepScorecard(snapshot, repId, { fy: 2026 })             // full FY
 *   deriveRepScorecard(snapshot, repId, { start, end })
 *
 * Every KPI is null-tolerant: returns null for the metric (not 0) when the
 * required data isn't populated. UI must distinguish "no data" from "$0".
 *
 * Audit rule: every number must match PPP's FPRC_* reports for the same
 * (rep, period). The /api/admin/rep-validation endpoint walks the deltas.
 */

import {
  currentFY,
  currentFiscalQuarter,
  fiscalQuarterRange,
  fiscalRangeFor,
  type FiscalQuarter,
  type FiscalYear,
} from "@/lib/fiscal-year";
import { memoBySnapshot } from "@/lib/salesforce/derive-cache";
import type {
  SalesforceSnapshot,
  SnapshotOpp,
  SnapshotWorkOrder,
} from "@/lib/salesforce/queries";

/** Period selector — fiscal preferred, raw range for custom views. */
export type ScorecardPeriod =
  | { fy: FiscalYear; q?: FiscalQuarter }
  | { start: Date; end: Date };

export type RepScorecard = {
  rep: { id: string; name: string };
  period: { start: Date; end: Date; label: string; fy: FiscalYear | null; q: FiscalQuarter | null };

  /** Per-month 12-bucket series for KPI 1 prior-year overlay chart.
   *  buckets[0] is 12 months ago; buckets[11] is the trailing month.
   *  Each bucket carries the absolute month label, current-FY sales (won opps
   *  closed in that calendar month), and prior-FY sales for the same month. */
  monthlySalesChart: Array<{
    monthLabel: string;       // e.g. "Mar 2026"
    monthShort: string;       // e.g. "Mar"
    yearLabel: string;        // e.g. "2026"
    current: number;
    priorYear: number;
  }>;

  // KPI 1 — Revenue Performance
  sales: {
    totalSales: number;                    // SUM(Opp.QuotedSubtotalWithChangeOrder__c) where won, CloseDate in period
    goal: number | null;                   // TotalQuota__c.QuotaAssigned__c (Owner/Active/CFY) — null when not set
    goalIsDerived: boolean;                // true when goal = annual ÷ 4 (no SubQuota data); false when from SubQuota directly
    pctToGoal: number | null;              // sales / goal * 100; null when no goal
    rank: number | null;                   // dense rank vs field-standard reps; null when only 1 rep with sales
    rankOf: number | null;                 // denominator for rank ("3 of 24")
  };

  // KPI 6 — Gross Margin (completed WOs)
  margin: {
    avgGmPct: number | null;               // AVG(WO.Gross_Margin_Percent__c) over completed WOs in period
    totalGpDollars: number;                // SUM(WO.GrossProfit__c)
    completedCount: number;                // # of WOs in the avg denominator
    target: number | null;                 // User.Gross_Margin_Goal_Percent__c
    vsTarget: number | null;               // avgGmPct − target (percentage-points)
  };

  /** Prior-YOY same-quarter compare for KPI 1 (per Maloney FPRC).
   *  amount = total closed-won sales in the same fiscal-quarter of the prior FY.
   *  deltaPct = (current − prior) / prior × 100, or null when prior = 0. */
  priorYoy: {
    amount: number;
    deltaPct: number | null;
  };

  // KPI 4A — Close Rate (Opps CREATED in period; won fraction)
  closeRate: {
    overall: { won: number; total: number; pct: number | null };
    selfGen: { won: number; total: number; pct: number | null };
    marketing: { won: number; total: number; pct: number | null };
  };

  // KPI 4B — Sales Mix (self-gen $ share, won + Opp Created CFY + Close Date PFQ).
  // Compares Self-Gen share vs goal (User.Self_Gen_Sales_Goal_Percent__c).
  salesMix: {
    selfGenDollars: number;
    marketingDollars: number;
    selfGenSharePct: number | null;
    /** Per-rep target (0-100). null when not configured on the User record. */
    goalPct: number | null;
    /** Actual − goal in percentage points; positive = ahead, negative = behind. */
    vsGoal: number | null;
    /** Won-opp count in the period (denominator for "53 Won Opps" sub-text). */
    totalWonOpps: number;
    /** Total won $ in period (selfGen + marketing). */
    totalWonSales: number;
  };

  // KPI 5 — Pricing Discipline (Opp Close CFY · WO End PFQ, attendance-logged subset)
  pricing: {
    revPerLaborDayProjected: number | null; // $ / projected labor day
    revPerLaborDayActual: number | null;    // $ / actual labor day
    /** $-denominated delta (actual − projected). Per Maloney FPRC PDF. */
    actualVsProjectedDollar: number | null;
    excludedNoAttendance: number;           // WOs dropped from numerator/denom for missing attendance
    /** Total completed WOs in the pricing pool — denominator for the
     *  "Excludes X of Y closed WOs — attendance not logged" callout. */
    completedTotal: number;
    materialsPct: number | null;            // SUM(TotalNonBillablePurchases__c) / SUM(quoted)
  };

  // KPI 4b — Crew Attendance Completeness (data quality gauge)
  attendance: {
    completed: number;
    logged: number;
    completenessPct: number | null;         // logged / completed
  };

  // KPI 2 — Appointments Activity (Opp Created CFY · Appt Scheduled PFQ).
  appointments: {
    scheduled: number;                      // total opps (created in cohort) with AppointmentDate in period
    run: number;                            // scheduled AND not cancelled
    runWithEstimate: number;                // raw count of run + estimate_sent
    estimatesSentPct: number | null;        // of run, % with Estimate_Sent__c
    cancelledCount: number;                 // raw count of cancelled appts in period
    cancelledPct: number | null;            // of scheduled, % cancelled
    /** Avg days from appointmentDate → dateEstimateSent for appts that got
     *  an estimate. Lower is better. PPP's cycle is 3-4 weeks so a 7-day
     *  estimate-turnaround target is reasonable. Per Katie 2026-06-10:
     *  "very important for them to see." */
    avgDaysToEstimate: number | null;
    /** % of with-estimate appts where the gap > 7 days. Katie's "% of
     *  estimates that took 7+ days to send" callout. */
    slowEstimatePct: number | null;
  };

  // KPI 3 — Pipeline Management (SNAPSHOT, not period-scoped). NOTE: scoped to the
  // snapshot's 365-day CreatedDate window — opps created >12 months ago are not
  // present (~2/3 of all-time "open" opps on PPP, but those are overwhelmingly
  // dead deals nobody closed). UI labels this "last 12 months". See §A.
  pipeline: {
    openOpps: number;
    staleEstimates: number;                 // open + estimate_sent + dateEstimateSent < today-30
    stalePct: number | null;                // staleEstimates / openOpps
    /** Cutoff date for the stale calc — UI surfaces this so reps can tell
     *  the snapshot is fresh (per Maloney FPRC "Cutoff 2026-05-06"). ISO YMD. */
    cutoffDate: string;
    /** True when openOpps is sourced from the 365-day snapshot window
     *  rather than an all-time SF query. UI shows a caveat when true. */
    scopedToLast12Months: boolean;
  };

  // KPI 7 — Production Quality
  production: {
    jobsCompleted: number;                  // WO Status IN (Closed, Complete Paid in Full), EndDate in period
    oppsWon: number;                        // Opp IsWon=true, CloseDate in period
    completionRatio: number | null;         // jobsCompleted / oppsWon
    goodReviews: number;
    badReviews: number;
    complaints: number;                     // Case count
    changeOrders: number;                   // SUM(WO.TotalChangeOrder__c) over completed WOs in period
  };

  // KPI 8 — Money Flow (Transaction__c, Date__c in period)
  // Per Katie 2026-06-10: record counts surfaced alongside $ figures, plus
  // Balance Owed (SUM(WO.BalanceOwed__c) on completed WOs in period).
  moneyFlow: {
    moneyCollected: number;                 // SUM Payment_In
    moneyCollectedCount: number;            // # of Payment_In transactions
    laborPaidOut: number;                   // SUM Payment_Out + PayeeType=Labor_Company
    laborPaidOutCount: number;              // # of labor payouts
    purchases: number;                      // SUM Purchase
    purchasesCount: number;                 // # of purchases
    /** SUM(WO.BalanceOwed__c) on completed WOs (EndDate in period). */
    balanceOwed: number;
    balanceOwedCount: number;               // # of completed WOs contributing to balanceOwed
  };

  // KPI 9 — Commissions (CFY-to-date)
  commissions: {
    drawReceived: number | null;            // User.Quarterly_Draw__c, scaled by period
    /** Per-quarter draw $ from User.Quarterly_Draw__c (raw, unscaled). */
    drawQuarterly: number | null;
    /** Number of fiscal quarters covered in the running total (e.g. Q1→1,
     *  Q2→2). Used to render "$13,333/qtr × 1 (CFY to date)". */
    quartersInPeriod: number | null;
    earned: number;                         // SUM(Transaction Payment_Out with WO + Payee=rep name)
    /** Count of Sales/Draw payouts that summed into `earned`. */
    payoutCount: number;
    difference: number | null;              // earned − draw; positive = underpaid (green), negative = overpaid (red)
  };
};

/* ─── Internal helpers ─── */

function rangeFor(period: ScorecardPeriod): { start: Date; end: Date; fy: FiscalYear | null; q: FiscalQuarter | null; label: string } {
  if ("start" in period) {
    return {
      start: period.start,
      end: period.end,
      fy: null,
      q: null,
      label: `${period.start.toISOString().split("T")[0]} → ${period.end.toISOString().split("T")[0]}`,
    };
  }
  if (period.q) {
    const r = fiscalQuarterRange(period.fy, period.q);
    return { ...r, fy: period.fy, q: period.q, label: `FY${String(period.fy).slice(-2)} Q${period.q}` };
  }
  const r = fiscalRangeFor(period.fy);
  return { ...r, fy: period.fy, q: null, label: `FY${String(period.fy).slice(-2)}` };
}

/** Cohort range — the fiscal YEAR containing the selected report period. Used
 *  by the Maloney FPRC two-window queries: "Opp Created CFY · Close Date PFQ"
 *  means filter by created-in-cohort AND closed-in-selected-period. When the
 *  selected period is itself a full FY (CFY/PFY), cohort == period. For
 *  arbitrary date ranges (no fy anchor) cohort == period as a fallback. */
function cohortRangeFor(period: ScorecardPeriod, fallback: { start: Date; end: Date }): { start: Date; end: Date } {
  if ("start" in period) return fallback;
  return fiscalRangeFor(period.fy);
}

/** Prior-year same-quarter range for the YOY compare on KPI 1. */
function priorYearSameRange(
  period: ScorecardPeriod,
  fallback: { start: Date; end: Date }
): { start: Date; end: Date } | null {
  if ("start" in period) {
    // Arbitrary date range — shift back 365 days as a best-effort fallback.
    const ms = 365 * 86_400_000;
    return { start: new Date(fallback.start.getTime() - ms), end: new Date(fallback.end.getTime() - ms) };
  }
  const priorFy = (period.fy - 1) as FiscalYear;
  if (period.q) return fiscalQuarterRange(priorFy, period.q);
  return fiscalRangeFor(priorFy);
}

function inRange(iso: string | null, start: Date, end: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  return t >= start.getTime() && t < end.getTime();
}

function safePct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return (num / den) * 100;
}

const COMPLETED_STATUSES = new Set(["closed", "complete paid in full", "complete balance owed"]);
function isCompletedWo(w: SnapshotWorkOrder): boolean {
  return COMPLETED_STATUSES.has((w.status ?? "").toLowerCase());
}

// FPRC KPI 6 (Gross Margin) + KPI 5 (Pricing) use only the strict pair —
// Balance-Owed jobs report separately on PPP's cards. The attendance-quality
// gauge keeps the broader COMPLETED_STATUSES so completeness isn't
// artificially deflated.
const GM_PRICING_STATUSES = new Set(["closed", "complete paid in full"]);
function isGmPricingCompletedWo(w: SnapshotWorkOrder): boolean {
  return GM_PRICING_STATUSES.has((w.status ?? "").toLowerCase());
}

// FPRC self-gen bucket (report-mirror overhaul 2026-05-21): four LeadGroup
// values count as self-generated; everything else (incl. null / Partnership)
// is marketing, so self-gen + marketing always reconciles to the total.
const SELF_GEN_LEAD_GROUPS = new Set([
  "Self-Generated", "Trade Show", "Repeat", "Referral",
]);
function isSelfGen(o: SnapshotOpp): boolean {
  return SELF_GEN_LEAD_GROUPS.has(o.leadGroup ?? "");
}

/**
 * Choose a period anchor for each WO — prefer EndDate (PPP's Gross Margin
 * anchor), fall back to closeDate when EndDate is null (common on older WOs).
 */
function woPeriodAnchor(w: SnapshotWorkOrder): string | null {
  return w.endDate ?? w.closeDate;
}

/* ─── Public entry point ─── */

export function deriveRepScorecard(
  snapshot: SalesforceSnapshot,
  repId: string,
  period: ScorecardPeriod = { fy: currentFY(), q: currentFiscalQuarter() }
): RepScorecard | null {
  // Cache key composed from repId + a stable serialization of period. Each
  // period type carries different fields (fy/q, fy only, or start/end dates)
  // — JSON.stringify gives a deterministic, sortable string across all three.
  const periodKey = JSON.stringify(period);
  return memoBySnapshot(snapshot, "deriveRepScorecard", `${repId}:${periodKey}`,
    () => deriveRepScorecardInner(snapshot, repId, period));
}

function deriveRepScorecardInner(
  snapshot: SalesforceSnapshot,
  repId: string,
  period: ScorecardPeriod
): RepScorecard | null {
  const rep = snapshot.reps.find((r) => r.id === repId);
  if (!rep) return null;

  const range = rangeFor(period);
  const { start, end, fy, q, label } = range;
  // Cohort range — the FY containing the selected period. Per Maloney FPRC,
  // multiple KPIs filter by "Opp Created CFY" + "Close Date PFQ" together.
  const cohort = cohortRangeFor(period, { start, end });

  /* ─ KPI 1 ─ Revenue + Goal + % to Goal + Prior YOY ─
     Spec: Won Opps · Created CFY · Close Date PFQ. */
  let totalSales = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
    if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    totalSales += o.quotedSubtotal;
  }

  // Prior YOY — same fiscal quarter (or fiscal year) one year earlier,
  // cohort filter shifted back too (Opp Created in priorCFY · Close in priorPFQ).
  const priorPeriod = priorYearSameRange(period, range);
  const priorCohort = "start" in period
    ? { start: new Date(cohort.start.getTime() - 365 * 86_400_000), end: new Date(cohort.end.getTime() - 365 * 86_400_000) }
    : fiscalRangeFor((period.fy - 1) as FiscalYear);
  let priorTotalSales = 0;
  if (priorPeriod) {
    for (const o of snapshot.opportunities) {
      if (o.ownerId !== repId) continue;
      if (!o.isWon) continue;
      if (!inRange(o.createdDate, priorCohort.start, priorCohort.end)) continue;
      if (!inRange(o.closeDate, priorPeriod.start, priorPeriod.end)) continue;
      priorTotalSales += o.quotedSubtotal;
    }
  }
  const priorYoyDeltaPct = priorTotalSales > 0 ? ((totalSales - priorTotalSales) / priorTotalSales) * 100 : null;

  // Monthly chart — 12 buckets ending at the selected period's end month.
  // Each bucket carries current-FY won sales (closed in that month) + prior-FY
  // won sales (closed in same month one year earlier). Drives the KPI 1
  // overlay chart per Maloney FPRC layout.
  const monthlyBuckets: Array<{ start: Date; end: Date; label: string; short: string; year: string }> = [];
  {
    const anchorEnd = end;
    // Walk 12 months backward from the period's end month.
    for (let i = 11; i >= 0; i--) {
      const monthDate = new Date(Date.UTC(anchorEnd.getUTCFullYear(), anchorEnd.getUTCMonth() - 1 - i, 1));
      const monthEnd = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1));
      const monthLabel = monthDate.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      monthlyBuckets.push({
        start: monthDate,
        end: monthEnd,
        label: `${monthLabel} ${monthDate.getUTCFullYear()}`,
        short: monthLabel,
        year: String(monthDate.getUTCFullYear()),
      });
    }
  }
  const monthlySalesChart: RepScorecard["monthlySalesChart"] = monthlyBuckets.map((b) => {
    let current = 0, priorYear = 0;
    const priorStart = new Date(b.start.getTime());
    priorStart.setUTCFullYear(priorStart.getUTCFullYear() - 1);
    const priorEnd = new Date(b.end.getTime());
    priorEnd.setUTCFullYear(priorEnd.getUTCFullYear() - 1);
    for (const o of snapshot.opportunities) {
      if (o.ownerId !== repId) continue;
      if (!o.isWon) continue;
      if (inRange(o.closeDate, b.start, b.end)) current += o.quotedSubtotal;
      else if (inRange(o.closeDate, priorStart, priorEnd)) priorYear += o.quotedSubtotal;
    }
    return { monthLabel: b.label, monthShort: b.short, yearLabel: b.year, current, priorYear };
  });

  // Goal lookup — prefer SubQuotas summed for the period (KPI 1 monthly), fall
  // back to TotalQuota for the FY when SubQuotas aren't populated. Track
  // whether goal was DERIVED (annual ÷ 4) vs DIRECTLY READ so UI can show it.
  let goal: number | null = null;
  let goalIsDerived = false;
  if (fy && q) {
    // Quarterly goal = sum of the 3 fiscal-quarter SubQuotas
    // Q1 (Feb-Apr) = calendar months 2,3,4; Q2 (May-Jul) = 5,6,7; etc.
    const calMonthsByQ: Record<FiscalQuarter, number[]> = {
      1: [2, 3, 4],
      2: [5, 6, 7],
      3: [8, 9, 10],
      4: [11, 12, 1],
    };
    const months = calMonthsByQ[q];
    let subQuotaSum = 0;
    let foundAny = false;
    for (const sq of snapshot.subQuotas) {
      if (sq.userId !== repId) continue;
      if (sq.fy !== fy) continue;
      if (!months.includes(sq.fiscalMonth)) continue;
      subQuotaSum += sq.assigned;
      foundAny = true;
    }
    if (foundAny) goal = subQuotaSum;
  }
  if (goal === null && fy !== null) {
    // FY annual goal from TotalQuota. NOTE: PPP has ~18 rep quota rows
    // populated as $0 placeholders (workflow created the row but the
    // manager hasn't filled in the dollar amount yet). Treat $0 as
    // "not set" — a 0% to Goal would be misleading.
    //
    // PPP fallback: SubQuota__c monthly data is empty for FY26 (PPP stopped
    // maintaining it). When asked for a quarterly period and we only have
    // the annual quota, derive quarterly goal = annual ÷ 4. Mark via
    // `goalIsDerived` so UI can show a "(annual ÷ 4)" caveat.
    const tq = snapshot.quotas.find((q2) => q2.userId === repId && q2.fy === fy);
    if (tq && tq.quotaAssigned > 0) {
      if (q) {
        goal = tq.quotaAssigned / 4;
        goalIsDerived = true;
      } else {
        goal = tq.quotaAssigned;
      }
    }
  }

  // Rank vs field-standard reps (dense rank by totalSales).
  const fieldReps = snapshot.reps.filter((r) => r.isFieldStandard);
  let rank: number | null = null;
  let rankOf: number | null = null;
  if (fieldReps.length > 1) {
    // Compute every field rep's sales for the same period.
    const repSales = new Map<string, number>();
    for (const o of snapshot.opportunities) {
      if (!o.isWon) continue;
      if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
      if (!inRange(o.closeDate, start, end)) continue;
      repSales.set(o.ownerId, (repSales.get(o.ownerId) ?? 0) + o.quotedSubtotal);
    }
    const fieldRepSales = fieldReps.map((r) => ({
      id: r.id,
      sales: repSales.get(r.id) ?? 0,
    }));
    fieldRepSales.sort((a, b) => b.sales - a.sales);
    // Dense rank — ties share a rank.
    let currentRank = 0;
    let prevSales = -1;
    for (let i = 0; i < fieldRepSales.length; i++) {
      const row = fieldRepSales[i];
      if (row.sales !== prevSales) {
        currentRank = i + 1;
        prevSales = row.sales;
      }
      if (row.id === repId) {
        rank = currentRank;
        break;
      }
    }
    rankOf = fieldReps.length;
  }

  /* ─ KPI 6 ─ Gross Margin (Opp Close CFY · WO End PFQ, strict status set) ─ */
  let gmPctSum = 0;
  let gmPctCount = 0;
  let totalGp = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isGmPricingCompletedWo(w)) continue;
    // "Opp Close Date CFY" — WO.closeDate rolls up from the parent opp.
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    if (!inRange(w.endDate, start, end)) continue;
    if (w.grossMarginPercent !== null) {
      gmPctSum += w.grossMarginPercent;
      gmPctCount += 1;
    }
    totalGp += w.grossProfit;
  }
  const avgGmPct = gmPctCount > 0 ? gmPctSum / gmPctCount : null;
  // User.Gross_Margin_Goal_Percent__c — SF stores this as the % value (45, not 0.45).
  const gmTarget = rep.gmGoalPercent;
  const gmVsTarget = avgGmPct !== null && gmTarget !== null ? avgGmPct - gmTarget : null;

  /* ─ KPI 4A ─ Close Rate (Opp Created CFY · Close Date PFQ · won ÷ cohort) ─
     Cohort = opps created in CFY whose close date is in the selected period
     (won OR lost — the close-out itself defines membership). */
  let overallTotal = 0, overallWon = 0;
  let selfTotal = 0, selfWon = 0;
  let mktTotal = 0, mktWon = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    overallTotal += 1;
    if (o.isWon) overallWon += 1;
    if (isSelfGen(o)) {
      selfTotal += 1;
      if (o.isWon) selfWon += 1;
    } else {
      mktTotal += 1;
      if (o.isWon) mktWon += 1;
    }
  }

  /* ─ KPI 4B ─ Sales Mix (Opp Created CFY · won + Close Date PFQ) ─ */
  let selfDollars = 0, mktDollars = 0;
  let salesMixWonOpps = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
    if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    salesMixWonOpps += 1;
    if (isSelfGen(o)) selfDollars += o.quotedSubtotal;
    else mktDollars += o.quotedSubtotal;
  }
  const totalMixDollars = selfDollars + mktDollars;

  /* ─ KPI 5 ─ Pricing Discipline (Opp Close CFY · WO End PFQ, attendance-logged subset) ─ */
  let pricingRevenueLogged = 0;
  let projectedDaysSum = 0;
  let actualDaysSum = 0;
  let materialsRevenue = 0;
  let materialsCost = 0;
  let excludedNoAttendance = 0;
  let pricingCompletedTotal = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isGmPricingCompletedWo(w)) continue;
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    if (!inRange(w.endDate, start, end)) continue;
    pricingCompletedTotal += 1;
    // Materials % includes all completed WOs (not just attendance-logged).
    if (w.quotedSubtotal > 0) {
      materialsRevenue += w.quotedSubtotal;
      materialsCost += w.totalNonBillablePurchases;
    }
    // Pricing ratios — restrict to attendance-logged subset only (KPI 5 spec).
    const hasActual = w.laborDaysActual !== null && w.laborDaysActual > 0;
    const hasProjected = w.laborDaysProjected !== null && w.laborDaysProjected > 0;
    if (!hasActual) {
      excludedNoAttendance += 1;
      continue;
    }
    if (!hasProjected) continue;
    pricingRevenueLogged += w.quotedSubtotal;
    projectedDaysSum += w.laborDaysProjected!;
    actualDaysSum += w.laborDaysActual!;
  }
  const revPerLaborDayProjected = projectedDaysSum > 0 ? pricingRevenueLogged / projectedDaysSum : null;
  const revPerLaborDayActual = actualDaysSum > 0 ? pricingRevenueLogged / actualDaysSum : null;
  const actualVsProjectedDollar = revPerLaborDayActual !== null && revPerLaborDayProjected !== null
    ? revPerLaborDayActual - revPerLaborDayProjected
    : null;
  const materialsPct = safePct(materialsCost, materialsRevenue);

  /* ─ Attendance completeness (data-quality gauge) ─ */
  let attendanceCompleted = 0;
  let attendanceLogged = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isCompletedWo(w)) continue;
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    if (!inRange(w.endDate, start, end)) continue;
    attendanceCompleted += 1;
    if (w.laborDaysActual !== null && w.laborDaysActual > 0) attendanceLogged += 1;
  }

  /* ─ KPI 2 ─ Appointments Activity (Opp Created CFY · Appt Scheduled date PFQ) ─
     Speed-to-estimate (avg days, % > 7 days) restored per Katie 2026-06-10
     follow-up: "very important for them to see." */
  let scheduled = 0;
  let run = 0;
  let runWithEstimate = 0;
  let cancelled = 0;
  let estimateDaysSum = 0;
  let estimateDaysCount = 0;
  let slowEstimateCount = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
    if (!inRange(o.appointmentDate, start, end)) continue;
    scheduled += 1;
    if (o.cancelledAppointment) {
      cancelled += 1;
    } else {
      run += 1;
      if (o.estimateSent) {
        runWithEstimate += 1;
        // Speed-to-estimate calc — only when both anchors exist AND the
        // appointment has actually happened (apptDate <= today). Future-
        // scheduled appointments aren't turnaround data; including them
        // would skew the metric optimistically.
        //   - appointmentDate must be in the past (already happened)
        //   - dateEstimateSent must be >= appointmentDate (real turnaround)
        //   - gap <= 90 days (drops stale/orphan data-entry artifacts)
        if (o.appointmentDate && o.dateEstimateSent) {
          const aMs = new Date(o.appointmentDate).getTime();
          const eMs = new Date(o.dateEstimateSent).getTime();
          const nowMs = Date.now();
          if (!isNaN(aMs) && !isNaN(eMs) && aMs <= nowMs) {
            const days = (eMs - aMs) / 86_400_000;
            if (days >= 0 && days <= 90) {
              estimateDaysSum += days;
              estimateDaysCount += 1;
              if (days > 7) slowEstimateCount += 1;
            }
          }
        }
      }
    }
  }
  const avgDaysToEstimate = estimateDaysCount > 0
    ? estimateDaysSum / estimateDaysCount
    : null;
  const slowEstimatePct = estimateDaysCount > 0
    ? (slowEstimateCount / estimateDaysCount) * 100
    : null;

  /* ─ KPI 3 ─ Pipeline Management (Open Opps · Created all-time · Status Open · snapshot) ─
     PDF spec is "all-time" but the snapshot's Opp query is windowed to the
     last 365 days. We surface what's in scope + flag scopedToLast12Months so
     UI can show a caveat until IT widens the snapshot query. On PPP's 3-4
     week cycle, opps open >12 months are almost always dead deals nobody
     marked closed — so the loss is small in practice. */
  let openOpps = 0;
  let staleEstimates = 0;
  const thirtyDaysAgoMs = Date.now() - 30 * 86_400_000;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (o.isClosed) continue;
    openOpps += 1;
    if (!o.estimateSent || !o.dateEstimateSent) continue;
    const dt = new Date(o.dateEstimateSent).getTime();
    if (!isNaN(dt) && dt < thirtyDaysAgoMs) staleEstimates += 1;
  }
  const cutoffDate = new Date(thirtyDaysAgoMs).toISOString().split("T")[0];

  /* ─ KPI 7 ─ Production Quality (Opp Close CFY · WO End PFQ for completed) ─ */
  let jobsCompleted = 0;
  let changeOrders = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    // PPP excludes "Complete Balance Owed" from this specific KPI ratio —
    // jobs-completed-vs-sold uses the stricter Closed / Complete Paid in Full set.
    const s = (w.status ?? "").toLowerCase();
    if (s !== "closed" && s !== "complete paid in full") continue;
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    if (!inRange(w.endDate, start, end)) continue;
    jobsCompleted += 1;
    changeOrders += w.totalChangeOrder ?? 0;
  }
  // "Sold" = KPI 1 won set (Created CFY · Close Date PFQ).
  let oppsWonInPeriod = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
    if (!inRange(o.createdDate, cohort.start, cohort.end)) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    oppsWonInPeriod += 1;
  }
  // Reviews — by Account.OwnerId (NOT Opp/WO owner per KPI 7 spec).
  let goodReviews = 0;
  let badReviews = 0;
  for (const r of snapshot.reviews) {
    if (r.isRemoved) continue;
    if (r.accountOwnerId !== repId) continue;
    if (!inRange(r.createdDate, start, end)) continue;
    if (r.isGood) goodReviews += 1;
    if (r.isBad) badReviews += 1;
  }
  // Complaints — by Opportunity__r.OwnerId (KPI 7 spec). FPRC counts only the
  // two true "complaint" Case types; the snapshot pulls all 6 customer-facing
  // types, so narrow here.
  const COMPLAINT_TYPES = new Set(["Dissatisfied Customer", "Service Call"]);
  let complaints = 0;
  for (const c of snapshot.cases) {
    if (c.opportunityOwnerId !== repId) continue;
    if (!COMPLAINT_TYPES.has(c.type ?? "")) continue;
    if (!inRange(c.createdDate, start, end)) continue;
    complaints += 1;
  }

  /* ─ KPI 8 ─ Money Flow (Opp Close Date CFY, Transaction Date PFQ) ─
     Spec: transactions whose linked WO's parent opp closed within CFY AND
     whose own Transaction Date falls inside the selected period. Build the
     cohort set of WO IDs first so we don't pay the inRange test per-txn. */
  const cohortWoIds = new Set<string>();
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    cohortWoIds.add(w.id);
  }
  let moneyCollected = 0;
  let moneyCollectedCount = 0;
  let laborPaidOut = 0;
  let laborPaidOutCount = 0;
  let purchases = 0;
  let purchasesCount = 0;
  for (const t of snapshot.transactions) {
    if (t.workOrderOwnerId !== repId) continue;
    if (t.workOrderId === null || !cohortWoIds.has(t.workOrderId)) continue;
    if (!inRange(t.date, start, end)) continue;
    if (t.recordType === "Payment_In") {
      moneyCollected += t.amount;
      moneyCollectedCount += 1;
    } else if (t.recordType === "Payment_Out" && t.payeeType === "Labor_Company") {
      laborPaidOut += t.amount;
      laborPaidOutCount += 1;
    } else if (t.recordType === "Purchase") {
      purchases += t.amount;
      purchasesCount += 1;
    }
  }
  // Balance Owed — per Maloney FPRC: WOs whose Status is specifically
  // "Complete Balance Owed" (not paid in full), Opp Close in CFY + WO End
  // in period. Sums BalanceOwed__c; count is WO-level not transaction-level.
  let balanceOwed = 0;
  let balanceOwedCount = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    const s = (w.status ?? "").toLowerCase();
    if (s !== "complete balance owed") continue;
    if (!inRange(w.closeDate, cohort.start, cohort.end)) continue;
    if (!inRange(w.endDate, start, end)) continue;
    balanceOwedCount += 1;
    if (typeof w.balanceOwed === "number") balanceOwed += w.balanceOwed;
  }

  /* ─ KPI 9 ─ Commissions (CFY-to-date, NOT the single quarter) ─
     Earned = Payment_Out paid to the rep against their draw: PayeeType='Sales'
     AND Description contains "Draw", Date in CFY, attributed by Payee name. */
  const cfy = fy !== null ? fiscalRangeFor(fy) : { start, end };
  let earned = 0;
  let payoutCount = 0;
  const repNameLower = rep.name.toLowerCase();
  for (const t of snapshot.transactions) {
    if (t.recordType !== "Payment_Out") continue;
    if (!t.workOrderId) continue;
    if (t.payeeType !== "Sales") continue;
    if (!(t.description ?? "").toLowerCase().includes("draw")) continue;
    if (!t.payeeName) continue;
    if (!inRange(t.date, cfy.start, cfy.end)) continue;
    const payee = t.payeeName.toLowerCase();
    if (
      payee === repNameLower ||
      payee.startsWith(`${repNameLower}-`) ||   // shadow Users
      payee === `lc ${repNameLower}`            // labor-company payee alias
    ) {
      earned += t.amount;
      payoutCount += 1;
    }
  }
  // Draw Received = quarterly draw × fiscal-quarter index, CFY-to-date (Q1→×1 … Q4→×4).
  // Falls back to prorated when caller passed a raw range (no fiscal anchor).
  // Quarters covered by the running draw total:
  //  - Specific-quarter period (PFQ/CFQ) → just that quarter's index (1-4)
  //  - Full FY in the past (PFY) → 4 (rep collected all 4 quarterly draws)
  //  - Current FY (CFY) → the current fiscal quarter (1-4, capped)
  //  - Arbitrary date range → null (caller will prorate by days)
  const quartersInPeriod = q !== null
    ? q
    : (fy !== null
        ? (fy < currentFY() ? 4 : Math.max(1, Math.min(4, currentFiscalQuarter())))
        : null);
  const drawReceived = rep.quarterlyDraw !== null
    ? (quartersInPeriod !== null
        ? rep.quarterlyDraw * quartersInPeriod
        : (rep.quarterlyDraw / 91) * ((end.getTime() - start.getTime()) / 86_400_000))
    : null;
  const difference = drawReceived !== null ? earned - drawReceived : null;

  return {
    rep: { id: rep.id, name: rep.name },
    period: { start, end, label, fy, q },

    sales: {
      totalSales,
      goal,
      goalIsDerived,
      pctToGoal: goal !== null && goal > 0 ? (totalSales / goal) * 100 : null,
      rank,
      rankOf,
    },

    margin: {
      avgGmPct,
      totalGpDollars: totalGp,
      completedCount: gmPctCount,
      target: gmTarget,
      vsTarget: gmVsTarget,
    },

    closeRate: {
      overall: { won: overallWon, total: overallTotal, pct: safePct(overallWon, overallTotal) },
      selfGen: { won: selfWon, total: selfTotal, pct: safePct(selfWon, selfTotal) },
      marketing: { won: mktWon, total: mktTotal, pct: safePct(mktWon, mktTotal) },
    },

    salesMix: (() => {
      const sharePct = safePct(selfDollars, totalMixDollars);
      // Goal is stored 0-100 OR 0-1 depending on PPP's SF field config. Detect
      // and normalize: any value < 1 is treated as a fraction (× 100).
      const goalRaw = rep.selfGenSalesGoalPercent;
      const goalPct = goalRaw === null ? null : (goalRaw < 1 ? goalRaw * 100 : goalRaw);
      const vsGoal = sharePct !== null && goalPct !== null ? sharePct - goalPct : null;
      return {
        selfGenDollars: selfDollars,
        marketingDollars: mktDollars,
        selfGenSharePct: sharePct,
        goalPct,
        vsGoal,
        totalWonOpps: salesMixWonOpps,
        totalWonSales: totalMixDollars,
      };
    })(),

    pricing: {
      revPerLaborDayProjected,
      revPerLaborDayActual,
      actualVsProjectedDollar,
      excludedNoAttendance,
      completedTotal: pricingCompletedTotal,
      materialsPct,
    },

    attendance: {
      completed: attendanceCompleted,
      logged: attendanceLogged,
      completenessPct: safePct(attendanceLogged, attendanceCompleted),
    },

    appointments: {
      scheduled,
      run,
      runWithEstimate,
      estimatesSentPct: safePct(runWithEstimate, run),
      cancelledCount: cancelled,
      cancelledPct: safePct(cancelled, scheduled),
      avgDaysToEstimate,
      slowEstimatePct,
    },

    pipeline: {
      openOpps,
      staleEstimates,
      stalePct: safePct(staleEstimates, openOpps),
      cutoffDate,
      scopedToLast12Months: true,
    },

    production: {
      jobsCompleted,
      oppsWon: oppsWonInPeriod,
      completionRatio: safePct(jobsCompleted, oppsWonInPeriod),
      goodReviews,
      badReviews,
      complaints,
      changeOrders,
    },

    moneyFlow: {
      moneyCollected,
      moneyCollectedCount,
      laborPaidOut,
      laborPaidOutCount,
      purchases,
      purchasesCount,
      balanceOwed,
      balanceOwedCount,
    },

    commissions: {
      drawReceived,
      drawQuarterly: rep.quarterlyDraw,
      quartersInPeriod,
      earned,
      payoutCount,
      difference,
    },

    priorYoy: {
      amount: priorTotalSales,
      deltaPct: priorYoyDeltaPct,
    },

    monthlySalesChart,
  };
}

/** Unused but exported so callers can build their own subset; keeps types reachable. */
export type { SnapshotCase, SnapshotReview, SnapshotTransaction } from "@/lib/salesforce/queries";
