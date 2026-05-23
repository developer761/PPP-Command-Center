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

  // KPI 6 — Pipeline Health (SNAPSHOT, not period-scoped)
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

function isSelfGen(o: SnapshotOpp): boolean {
  return o.leadGroup === "Self-Generated";
}

/**
 * Choose a period anchor for each WO — prefer EndDate (PPP's KPI 2 anchor),
 * fall back to closeDate when EndDate is null (common on older WOs).
 */
function woPeriodAnchor(w: SnapshotWorkOrder): string | null {
  return w.endDate ?? w.closeDate;
}

/** Convert a quarterly draw → period-prorated dollar amount. */
function scaleDraw(quarterlyDraw: number, periodStart: Date, periodEnd: Date): number {
  const days = (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
  // PPP fiscal quarter = ~91 days. Scale linearly.
  return (quarterlyDraw / 91) * days;
}

/* ─── Public entry point ─── */

export function deriveRepScorecard(
  snapshot: SalesforceSnapshot,
  repId: string,
  period: ScorecardPeriod = { fy: currentFY(), q: currentFiscalQuarter() }
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
  // back to TotalQuota for the FY when SubQuotas aren't populated.
  let goal: number | null = null;
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
    // FY annual goal from TotalQuota
    const tq = snapshot.quotas.find((q) => q.userId === repId && q.fy === fy);
    if (tq) goal = tq.quotaAssigned;
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

  /* ─ KPI 2 ─ Gross Margin (completed WOs) ─ */
  let gmPctSum = 0;
  let gmPctCount = 0;
  let totalGp = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isCompletedWo(w)) continue;
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

  /* ─ KPI 4 ─ Pricing Discipline + Materials % (completed WOs, attendance-logged subset) ─ */
  let pricingRevenueLogged = 0;
  let projectedDaysSum = 0;
  let actualDaysSum = 0;
  let materialsRevenue = 0;
  let materialsCost = 0;
  let excludedNoAttendance = 0;
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    if (!isCompletedWo(w)) continue;
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
        // Speed-to-estimate calc — only when we have both anchors.
        // Negative gaps (estimate sent before appt) are dropped as data
        // entry errors. Gaps > 90 days are also dropped (stale/orphan).
        if (o.appointmentDate && o.dateEstimateSent) {
          const aMs = new Date(o.appointmentDate).getTime();
          const eMs = new Date(o.dateEstimateSent).getTime();
          if (!isNaN(aMs) && !isNaN(eMs)) {
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

  /* ─ KPI 6 ─ Pipeline Health (SNAPSHOT) ─ */
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
  for (const w of snapshot.workOrders) {
    if (w.ownerId !== repId) continue;
    // PPP excludes "Complete Balance Owed" from this specific KPI ratio —
    // jobs-completed-vs-sold uses the stricter Closed / Complete Paid in Full set.
    const s = (w.status ?? "").toLowerCase();
    if (s !== "closed" && s !== "complete paid in full") continue;
    if (!inRange(woPeriodAnchor(w), start, end)) continue;
    jobsCompleted += 1;
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
  // Complaints — by Opportunity__r.OwnerId (KPI 7 spec).
  let complaints = 0;
  for (const c of snapshot.cases) {
    if (c.opportunityOwnerId !== repId) continue;
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

  /* ─ KPI 9 ─ Commissions ─ */
  // Earned = Transaction Payment_Out where WO is set AND Payee.Name matches
  // rep name. Spec note (REP_PERFORMANCE_KPIS.md): NOT scoped to rep's own
  // WOs — attribution is by Payee name match. Watch for `<Name>-inactive` /
  // `<Name>-portal` shadow Users; do a prefix match on the canonical name.
  let earned = 0;
  const repNameLower = rep.name.toLowerCase();
  for (const t of snapshot.transactions) {
    if (t.recordType !== "Payment_Out") continue;
    if (!t.workOrderId) continue;
    if (!t.payeeName) continue;
    if (!inRange(t.date, start, end)) continue;
    const payee = t.payeeName.toLowerCase();
    // Match exact or shadow-variant ("Karan Malhotra" / "Karan Malhotra-inactive").
    if (payee === repNameLower || payee.startsWith(`${repNameLower}-`)) {
      earned += t.amount;
    }
  }
  const drawReceived = rep.quarterlyDraw !== null ? scaleDraw(rep.quarterlyDraw, start, end) : null;
  const difference = drawReceived !== null ? earned - drawReceived : null;

  return {
    rep: { id: rep.id, name: rep.name },
    period: { start, end, label, fy, q },

    sales: {
      totalSales,
      goal,
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
