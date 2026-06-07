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

  // KPI 1 — Revenue Performance
  sales: {
    totalSales: number;                    // SUM(Opp.QuotedSubtotalWithChangeOrder__c) where won, CloseDate in period
    goal: number | null;                   // TotalQuota__c.QuotaAssigned__c (Owner/Active/CFY) — null when not set
    goalIsDerived: boolean;                // true when goal = annual ÷ 4 (no SubQuota data); false when from SubQuota directly
    pctToGoal: number | null;              // sales / goal * 100; null when no goal
    rank: number | null;                   // dense rank vs field-standard reps; null when only 1 rep with sales
    rankOf: number | null;                 // denominator for rank ("3 of 24")
  };

  // KPI 2 — Gross Margin (completed WOs)
  margin: {
    avgGmPct: number | null;               // AVG(WO.Gross_Margin_Percent__c) over completed WOs in period
    totalGpDollars: number;                // SUM(WO.GrossProfit__c)
    completedCount: number;                // # of WOs in the avg denominator
    target: number | null;                 // User.Gross_Margin_Goal_Percent__c
    vsTarget: number | null;               // avgGmPct − target (percentage-points)
  };

  // KPI 3 — Close Rate (Opps CREATED in period; won fraction)
  closeRate: {
    overall: { won: number; total: number; pct: number | null };
    selfGen: { won: number; total: number; pct: number | null };
    marketing: { won: number; total: number; pct: number | null };
  };

  // KPI 3b — Sales Mix (self-gen $ share, won + CloseDate in period)
  salesMix: {
    selfGenDollars: number;
    marketingDollars: number;
    selfGenSharePct: number | null;
  };

  // KPI 4 — Pricing Discipline (completed WOs, attendance-logged subset)
  pricing: {
    revPerLaborDayProjected: number | null; // $ / projected labor day
    revPerLaborDayActual: number | null;    // $ / actual labor day
    excludedNoAttendance: number;           // WOs dropped from numerator/denom for missing attendance
    materialsPct: number | null;            // SUM(TotalNonBillablePurchases__c) / SUM(quoted)
  };

  // KPI 4b — Crew Attendance Completeness (data quality gauge)
  attendance: {
    completed: number;
    logged: number;
    completenessPct: number | null;         // logged / completed
  };

  // KPI 5 — Appointments Activity (Opp.AppointmentDate__c in period)
  appointments: {
    scheduled: number;                      // total opps with AppointmentDate in period
    run: number;                            // scheduled AND not cancelled
    estimatesSentPct: number | null;        // of run, % with Estimate_Sent__c
    cancelledPct: number | null;            // of scheduled, % cancelled
    /** Avg days from appointmentDate → dateEstimateSent for appts that got
     *  an estimate. Lower is better — slow estimates kill conversion. */
    avgDaysToEstimate: number | null;
    /** % of with-estimate appts where the gap > 7 days. PPP cycle is 3-4
     *  weeks total, so a 7-day estimate-turnaround target is reasonable. */
    slowEstimatePct: number | null;
  };

  // KPI 6 — Pipeline Health (SNAPSHOT, not period-scoped). NOTE: scoped to the
  // snapshot's 365-day CreatedDate window — opps created >12 months ago are not
  // present (~2/3 of all-time "open" opps on PPP, but those are overwhelmingly
  // dead deals nobody closed). UI labels this "last 12 months". See §A.
  pipeline: {
    openOpps: number;
    staleEstimates: number;                 // open + estimate_sent + dateEstimateSent < today-30
    stalePct: number | null;                // staleEstimates / openOpps
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
  moneyFlow: {
    moneyCollected: number;                 // SUM Payment_In
    laborPaidOut: number;                   // SUM Payment_Out + PayeeType=Labor_Company
    purchases: number;                      // SUM Purchase
  };

  // KPI 9 — Commissions
  commissions: {
    drawReceived: number | null;            // User.Quarterly_Draw__c, scaled by period
    earned: number;                         // SUM(Transaction Payment_Out with WO + Payee=rep name)
    difference: number | null;              // earned − draw; positive = underpaid (green)
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

// FPRC KPI 2 (GM) + KPI 5 (Pricing) use only the strict pair — Balance-Owed
// jobs report separately on PPP's cards. Attendance gauge (KPI 4b) keeps the
// broader COMPLETED_STATUSES so completeness isn't artificially deflated.
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
 * Choose a period anchor for each WO — prefer EndDate (PPP's KPI 2 anchor),
 * fall back to closeDate when EndDate is null (common on older WOs).
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

  /* ─ KPI 1 ─ Revenue + Goal + % to Goal ─ */
  let totalSales = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    totalSales += o.quotedSubtotal;
  }

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

  /* ─ KPI 2 ─ Gross Margin (completed WOs, strict status set) ─ */
  let gmPctSum = 0;
  let gmPctCount = 0;
  let totalGp = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isGmPricingCompletedWo(w)) continue;
    if (!inRange(woPeriodAnchor(w), start, end)) continue;
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

  /* ─ KPI 3 ─ Close Rate (Opp CREATED in period, won fraction, leadgroup buckets) ─ */
  let overallTotal = 0, overallWon = 0;
  let selfTotal = 0, selfWon = 0;
  let mktTotal = 0, mktWon = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!inRange(o.createdDate, start, end)) continue;
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

  /* ─ KPI 3b ─ Sales Mix ($ share, CloseDate in period) ─ */
  let selfDollars = 0, mktDollars = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
    if (!inRange(o.closeDate, start, end)) continue;
    if (isSelfGen(o)) selfDollars += o.quotedSubtotal;
    else mktDollars += o.quotedSubtotal;
  }
  const totalMixDollars = selfDollars + mktDollars;

  /* ─ KPI 4 ─ Pricing Discipline + Materials % (completed WOs, strict status set, attendance-logged subset) ─ */
  let pricingRevenueLogged = 0;
  let projectedDaysSum = 0;
  let actualDaysSum = 0;
  let materialsRevenue = 0;
  let materialsCost = 0;
  let excludedNoAttendance = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isGmPricingCompletedWo(w)) continue;
    if (!inRange(woPeriodAnchor(w), start, end)) continue;
    // Materials % includes all completed WOs (not just attendance-logged).
    if (w.quotedSubtotal > 0) {
      materialsRevenue += w.quotedSubtotal;
      materialsCost += w.totalNonBillablePurchases;
    }
    // Pricing ratios — restrict to attendance-logged subset only (KPI 4 spec).
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
  const materialsPct = safePct(materialsCost, materialsRevenue);

  /* ─ KPI 4b ─ Attendance completeness ─ */
  let attendanceCompleted = 0;
  let attendanceLogged = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isCompletedWo(w)) continue;
    if (!inRange(woPeriodAnchor(w), start, end)) continue;
    attendanceCompleted += 1;
    if (w.laborDaysActual !== null && w.laborDaysActual > 0) attendanceLogged += 1;
  }

  /* ─ KPI 5 ─ Appointments Activity (+ Speed-to-Estimate signal) ─
     Speed-to-estimate is a more actionable signal than close rate for PPP
     because their close rate trends high (data quirk per §4.5). Reps with
     7+ day estimate turnaround see noticeably worse close + cancellation
     rates downstream. */
  let scheduled = 0;
  let run = 0;
  let runWithEstimate = 0;
  let cancelled = 0;
  let estimateDaysSum = 0;
  let estimateDaysCount = 0;
  let slowEstimateCount = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!inRange(o.appointmentDate, start, end)) continue;
    scheduled += 1;
    if (o.cancelledAppointment) {
      cancelled += 1;
    } else {
      run += 1;
      if (o.estimateSent) {
        runWithEstimate += 1;
        // Speed-to-estimate calc — only when we have both anchors AND the
        // appointment has actually happened (appointmentDate <= today).
        // Future-scheduled appointments aren't yet "run" turnaround data —
        // including them would skew the metric optimistically.
        //
        // Filter rules:
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

  /* ─ KPI 6 ─ Pipeline Health (SNAPSHOT, last-12-mo scope) ─ */
  // Only opps created in the snapshot's 365-day window are present. On PPP's
  // 3-4 week cycle an opp open for >12 months is almost certainly a dead deal
  // nobody marked closed, so this intentionally focuses on actionable recent
  // pipeline rather than the full all-time open count (§A). UI says "last 12 mo".
  // Stale = open + estimate_sent + dateEstimateSent < today-30
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

  /* ─ KPI 7 ─ Production Quality ─ */
  let jobsCompleted = 0;
  let changeOrders = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    // PPP excludes "Complete Balance Owed" from this specific KPI ratio —
    // jobs-completed-vs-sold uses the stricter Closed / Complete Paid in Full set.
    const s = (w.status ?? "").toLowerCase();
    if (s !== "closed" && s !== "complete paid in full") continue;
    if (!inRange(woPeriodAnchor(w), start, end)) continue;
    jobsCompleted += 1;
    changeOrders += w.totalChangeOrder ?? 0;
  }
  let oppsWonInPeriod = 0;
  for (const o of snapshot.opportunities) {
    if (o.ownerId !== repId) continue;
    if (!o.isWon) continue;
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

  /* ─ KPI 8 ─ Money Flow ─ */
  let moneyCollected = 0;
  let laborPaidOut = 0;
  let purchases = 0;
  for (const t of snapshot.transactions) {
    if (t.workOrderOwnerId !== repId) continue;
    if (!inRange(t.date, start, end)) continue;
    if (t.recordType === "Payment_In") moneyCollected += t.amount;
    else if (t.recordType === "Payment_Out" && t.payeeType === "Labor_Company") laborPaidOut += t.amount;
    else if (t.recordType === "Purchase") purchases += t.amount;
  }

  /* ─ KPI 9 ─ Commissions ─ (CFY-to-date, NOT the single quarter) ─ */
  // Earned = Payment_Out paid to the rep against their draw: PayeeType='Sales'
  // AND Description contains "Draw", Date in the current FY, attributed by Payee
  // name = "<rep>" or "LC <rep>" (labor-company alias). NOT scoped to the rep's
  // own WOs. Watch for "<name>-inactive" / "-portal" shadow Users.
  const cfy = fy !== null ? fiscalRangeFor(fy) : { start, end };
  let earned = 0;
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
    }
  }
  // Draw Received = quarterly draw × fiscal-quarter index, CFY-to-date (Q1→×1 … Q4→×4).
  // Falls back to prorated when caller passed a raw range (no fiscal anchor).
  const drawReceived = rep.quarterlyDraw !== null
    ? (q !== null
        ? rep.quarterlyDraw * q
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

    salesMix: {
      selfGenDollars: selfDollars,
      marketingDollars: mktDollars,
      selfGenSharePct: safePct(selfDollars, totalMixDollars),
    },

    pricing: {
      revPerLaborDayProjected,
      revPerLaborDayActual,
      excludedNoAttendance,
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
      estimatesSentPct: safePct(runWithEstimate, run),
      cancelledPct: safePct(cancelled, scheduled),
      avgDaysToEstimate,
      slowEstimatePct,
    },

    pipeline: {
      openOpps,
      staleEstimates,
      stalePct: safePct(staleEstimates, openOpps),
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
      laborPaidOut,
      purchases,
    },

    commissions: {
      drawReceived,
      earned,
      difference,
    },
  };
}

/** Unused but exported so callers can build their own subset; keeps types reachable. */
export type { SnapshotCase, SnapshotReview, SnapshotTransaction } from "@/lib/salesforce/queries";
