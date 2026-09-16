import "server-only";

import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { getJobCostsReport, type JobCostsReport } from "@/lib/commercial/reports/job-costs";
import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { getBalanceOwedRows } from "@/lib/commercial/reports/tomco/balance-owed";
import { getDealReportRows, schedulingRows, openSalesRows } from "@/lib/commercial/reports/tomco/opportunities";
import { getSpendRows, getMoneyInRows, purchaseRows, laborPaymentRows, reimbursementRows } from "@/lib/commercial/reports/tomco/transactions";
import { getAttendanceRows } from "@/lib/commercial/reports/tomco/attendance";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { getLaborReport } from "@/lib/commercial/reports/labor";
import { getEstimatorReport } from "@/lib/commercial/reports/estimator";
import { getCashFlowReport } from "@/lib/commercial/reports/cash-flow";
import { getChangeOrderVendorReport } from "@/lib/commercial/reports/change-orders-vendors";
import { listSignatureRequestsForReport } from "@/lib/commercial/esign/db";
import { summarizeSignatures } from "@/lib/commercial/esign/report";
import { getGeographyReport } from "@/lib/commercial/reports/geography";
import { getJobsOverviewRows } from "@/lib/commercial/reports/jobs";
import { summarizeJobRows } from "@/lib/commercial/reports/jobs-rows";
import { getWinLossSummary, currentQuarterRange } from "@/lib/commercial/win-loss/reports";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import {
  laborRange, LABOR_DEFAULT,
  estimatorRange, ESTIMATOR_DEFAULT, fiscalYearStartMonth,
  cashFlowRange, CASH_FLOW_DEFAULT,
  changeOrderRange, CHANGE_ORDER_DEFAULT,
  signatureRange, SIGNATURE_DEFAULT,
} from "@/lib/commercial/reports/presets";
import { reportDef, type ReportKey } from "./registry";

/**
 * The two numbers on each Reports-index card, keyed by registry entry.
 *
 * Lifted out of the index page when report folders arrived, so the page asks
 * for exactly the cards it is about to draw. A report the viewer can't see — or
 * one outside the folder that's open — never has its query run at all.
 *
 * Each card summarises the window its report OPENS on, resolved through the
 * report's own preset function, so the number on the card is the number you
 * land on.
 */

export type MetricTone = "brand" | "navy" | "amber" | "emerald" | "rose" | "neutral";
export type CardMetrics = {
  primary: { label: string; value: string; tone: MetricTone };
  secondary: { label: string; value: string; tone?: MetricTone };
};

type LoadCtx = { jobCosts?: Promise<JobCostsReport> };
type Loader = (ctx: LoadCtx) => Promise<CardMetrics>;

const LOADERS: Record<ReportKey, Loader> = {
  pipeline: async () => {
    const p = await getPipelineReport();
    return {
      primary: { label: "Weighted pipeline", value: formatCentsCompact(p.totals.weightedCents), tone: "brand" },
      secondary: { label: "Open", value: `${p.totals.count} ${p.totals.count === 1 ? "deal" : "deals"}` },
    };
  },
  "job-costs": async (ctx) => {
    const j = await (ctx.jobCosts ?? getJobCostsReport());
    const marginTone: MetricTone =
      j.totals.marginPct === null || j.totals.totalCostCents === 0
        ? "neutral"
        : j.totals.marginPct < 0 ? "rose" : j.totals.marginPct < 15 ? "amber" : "emerald";
    return {
      primary: { label: "Margin", value: j.totals.marginPct === null ? "—" : `${j.totals.marginPct}%`, tone: marginTone },
      secondary: { label: "Total cost", value: formatCentsCompact(j.totals.totalCostCents), tone: "amber" },
    };
  },
  jobs: async () => {
    // Shares the Job-costs card's `listProjects` call (request-memoised in
    // ./all-projects), so the two cards side by side cost one batch, not two.
    const rows = await getJobsOverviewRows();
    const totals = summarizeJobRows(rows);
    const inDelivery = totals.byGroup.delivery;
    return {
      primary: { label: "Jobs", value: String(totals.jobCount), tone: "navy" },
      secondary: {
        label: inDelivery > 0 ? "In delivery" : "Open balance",
        value: inDelivery > 0 ? String(inDelivery) : formatCentsCompact(totals.openBalanceCents),
        tone: inDelivery > 0 ? "brand" : "neutral",
      },
    };
  },
  geography: async () => {
    const g = await getGeographyReport();
    const top = g.byCity[0] ?? null;
    return {
      primary: { label: "Towns", value: String(g.totals.cityCount), tone: "navy" },
      secondary: { label: "Top town", value: top ? `${top.label} · ${top.dealCount}` : "—" },
    };
  },
  "cash-flow": async () => {
    const c = await getCashFlowReport(cashFlowRange(CASH_FLOW_DEFAULT));
    return {
      primary: { label: "Collected · 6 mo", value: formatCentsCompact(c.totals.collectedCents), tone: "emerald" },
      secondary: {
        label: "Days to pay",
        value: c.totals.avgDaysToPay === null ? "—" : `${c.totals.avgDaysToPay}d`,
        tone: c.totals.avgDaysToPay !== null && c.totals.avgDaysToPay > 60 ? "amber" : undefined,
      },
    };
  },
  receivables: async () => {
    const r = await getReceivablesReport();
    return {
      primary: { label: "Outstanding", value: formatCentsCompact(r.totalOpenCents), tone: "brand" },
      secondary: { label: "Past due", value: formatCentsCompact(r.overdueCents), tone: r.overdueCents > 0 ? "amber" : "neutral" },
    };
  },
  "ar-aging": async () => {
    const a = await getArAging();
    const overdue = a.totals.total - a.totals.current;
    return {
      primary: { label: "Total AR", value: formatCentsCompact(a.totals.total), tone: "brand" },
      secondary: { label: "Overdue", value: formatCentsCompact(overdue), tone: overdue > 0 ? "amber" : "neutral" },
    };
  },
  scheduling: async () => {
    const rows = schedulingRows(await getDealReportRows());
    return {
      primary: { label: "Jobs on", value: `${rows.length}`, tone: "brand" },
      secondary: { label: "Still owed", value: formatCentsCompact(rows.reduce((n, r) => n + r.balanceCents, 0)) },
    };
  },
  "open-sales": async () => {
    const rows = openSalesRows(await getDealReportRows());
    return {
      primary: { label: "Contract in flight", value: formatCentsCompact(rows.reduce((n, r) => n + r.contractCents, 0)), tone: "brand" },
      secondary: { label: "Open jobs", value: `${rows.length}` },
    };
  },
  attendance: async () => {
    const rows = await getAttendanceRows();
    const crews = new Set(rows.map((r) => r.crew));
    return {
      primary: { label: "Hours on site", value: `${Math.round(rows.reduce((n, r) => n + r.hours, 0)).toLocaleString()}h`, tone: "brand" },
      secondary: { label: "Crew", value: `${crews.size}` },
    };
  },
  estimator: async () => {
    const range = estimatorRange(ESTIMATOR_DEFAULT, await fiscalYearStartMonth());
    const e = await getEstimatorReport(range);
    return {
      primary: { label: `Win rate · ${range.label}`, value: e.totals.winRatePct === null ? "—" : `${e.totals.winRatePct}%`, tone: "emerald" },
      secondary: { label: "Bids sent", value: String(e.totals.bidsSent) },
    };
  },
  labor: async () => {
    const l = await getLaborReport(laborRange(LABOR_DEFAULT));
    const h = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return {
      primary: { label: "Hours (this month)", value: `${h(l.totalHours)}h`, tone: "navy" },
      secondary: {
        label: l.unratedHours > 0 ? "Unpriced hours" : "Labor cost",
        value: l.unratedHours > 0 ? `${h(l.unratedHours)}h` : formatCentsCompact(l.totalCostCents),
        tone: l.unratedHours > 0 ? "amber" : "neutral",
      },
    };
  },
  "change-orders": async () => {
    const c = await getChangeOrderVendorReport(changeOrderRange(CHANGE_ORDER_DEFAULT));
    return {
      primary: {
        label: c.co.unbilledCents > 0 ? "Approved, unbilled" : "Added scope · this year",
        value: formatCentsCompact(c.co.unbilledCents > 0 ? c.co.unbilledCents : c.co.approvedAddCents),
        tone: c.co.unbilledCents > 0 ? "amber" : "emerald",
      },
      // SAY THE WINDOW. This card runs on the report's default preset
      // (`this_year`), and "Vendor spend $736.6K" beside no period read as the
      // whole book — Tomco's all-time figure is $1.0M, so the card was 27%
      // light with nothing on it admitting the range. Every other windowed card
      // on this page names its period; this one did not.
      secondary: { label: "Vendor spend · this year", value: formatCentsCompact(c.vendorTotalCents) },
    };
  },
  signatures: async () => {
    const s = summarizeSignatures(await listSignatureRequestsForReport(signatureRange(SIGNATURE_DEFAULT)));
    return {
      primary: { label: "Signed · 90 days", value: String(s.proposalsSigned), tone: "emerald" },
      secondary: {
        label: s.awaitingCountersign > 0 ? "Need countersigning" : "Sent",
        value: String(s.awaitingCountersign > 0 ? s.awaitingCountersign : s.proposalsSent),
        tone: s.awaitingCountersign > 0 ? "amber" : undefined,
      },
    };
  },
  "win-loss": async () => {
    const quarter = currentQuarterRange();
    const w = await getWinLossSummary(quarter);
    const decided = w.wonCount + w.lostCount > 0;
    return {
      primary: { label: `Win rate · ${quarter.label}`, value: decided ? `${w.winRatePct}%` : "—", tone: "emerald" },
      secondary: { label: "Won", value: formatCentsCompact(w.wonValueCents), tone: "emerald" },
    };
  },
};

/**
 * Load the cards for `keys` only. One failing report costs one card — `failed`
 * names it out loud rather than letting the card quietly read $0.
 *
 * `jobCosts` lets the page share the job-costs report it already fetched for
 * the snapshot visuals instead of running it twice.
 */
export async function loadCardMetrics(
  keys: readonly ReportKey[],
  opts: { jobCosts?: Promise<JobCostsReport> } = {}
): Promise<{ metrics: Map<ReportKey, CardMetrics | null>; failed: string[] }> {
  const failed: string[] = [];
  const metrics = new Map<ReportKey, CardMetrics | null>();
  await Promise.all(
    keys.map(async (k) => {
      try {
        metrics.set(k, await LOADERS[k](opts));
      } catch (err) {
        console.error(`[reports] ${k} card failed:`, err);
        failed.push(reportDef(k).tabLabel);
        metrics.set(k, null);
      }
    })
  );
  return { metrics, failed };
}
