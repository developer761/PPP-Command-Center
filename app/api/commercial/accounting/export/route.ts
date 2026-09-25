import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { groupedReportCsv } from "@/lib/commercial/reports/grouped/csv";
import { getArSheetRows, AR_APPLICATIONS_SPEC, AR_PERIODS, arPeriodCutoff } from "@/lib/commercial/reports/tomco/ar-applications";
import { getBalanceOwedRows, BALANCE_OWED_SPEC } from "@/lib/commercial/reports/tomco/balance-owed";
import {
  getSpendRows,
  getMoneyInRows,
  purchaseRows,
  laborPaymentRows,
  PURCHASES_BY_VENDOR_SPEC,
  LABOR_PAYMENTS_SPEC,
  DEPOSIT_HISTORY_SPEC,
} from "@/lib/commercial/reports/tomco/transactions";
import {
  filterToSpendPeriod, isSpendPeriod, spendPeriodLabel,
} from "@/lib/commercial/reports/tomco/spend-periods";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export the Accounting tab you are actually on.
 *
 * The Export button used to be hard-wired to the receivables sheet, so however
 * deep into Purchases or the AR sheet Mary was, pressing it downloaded
 * Receivables — and the AR sheet is the one she sends Alex. Every tab that is a
 * grouped report exports itself now, from the SAME spec the page renders, so
 * the file and the screen cannot drift apart.
 *
 * The three tabs that already had their own endpoints — receivables,
 * transactions, sales tax — keep them; they carry filters this cannot.
 */
/**
 * EACH SHEET CARRIES ITS OWN GATE.
 *
 * One `guardExport({ report: "receivables", orAccounting: true })` covered all
 * five, so the permission being asked for was "are you in the Receivables
 * report folder" — for Purchases by vendor, crew payouts and the partner
 * deposit history, none of which are receivables. A rep put in a folder holding
 * only Receivables could pull all three by changing `?view=`.
 *
 * The sheets that ARE receivables keep the folder rule, so an account manager
 * outside the Finance folder still gets a working Export button on the tabs it
 * belongs to. The three Accounting-only registers require the Accounting roles,
 * and labor payouts additionally declare `people` — it is per-person pay, which
 * is the same role test for a different reason, and guardExport says in as many
 * words that a reader should not have to know they coincide.
 */
const SHEETS = {
  ar: {
    title: "Accounts Receivable",
    file: "AR_sheet",
    load: getArSheetRows,
    spec: AR_APPLICATIONS_SPEC,
    guard: { report: "receivables", orAccounting: true },
  },
  owed: {
    title: "Balance Owed",
    file: "Balance_owed",
    load: getBalanceOwedRows,
    spec: BALANCE_OWED_SPEC,
    guard: { report: "receivables", orAccounting: true },
  },
  purchases: {
    title: "Purchases by vendor",
    file: "Purchases",
    load: async () => purchaseRows(await getSpendRows()),
    spec: PURCHASES_BY_VENDOR_SPEC,
    guard: { accounting: true },
  },
  "labor-out": {
    title: "Labor payments out",
    file: "Labor_payments",
    load: async () => laborPaymentRows(await getSpendRows()),
    spec: LABOR_PAYMENTS_SPEC,
    // Per-person pay, by name and by amount.
    guard: { accounting: true, people: true },
  },
  deposits: {
    title: "Partner deposit history",
    file: "Deposits",
    load: getMoneyInRows,
    spec: DEPOSIT_HISTORY_SPEC,
    guard: { accounting: true },
  },
} as const;

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get("view") ?? "";
  const sheet = (SHEETS as Record<string, (typeof SHEETS)[keyof typeof SHEETS] | undefined>)[view];

  // The sheet's own gate, and the strictest one for a `view` we don't know —
  // so an unrecognised value can't be used to get a 400 without credentials.
  const guard = await guardExport(sheet?.guard ?? { accounting: true });
  if (!guard.ok) return guard.response;

  if (!sheet) {
    return new Response(`Nothing to export for "${view}".`, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each sheet
  // pairs its own loader with its own spec; the union is correct per key but
  // not expressible across the lookup.
  const rows = (await sheet.load()) as any[];

  /**
   * THE EXPORT MUST MATCH THE SCREEN.
   *
   * The AR sheet gained a period filter and a group-by (Karan 2026-09-17), and
   * a CSV that quietly ignores them is the worse half of the bug: you filter to
   * 30 days, press Export, and hand somebody a file covering all time with the
   * same title. Both controls ride on the URL, so both are read here.
   *
   * Undated rows are kept, exactly as the page keeps them — Mary's carried-over
   * lines have no certificate date, and a period that dropped them would export
   * an empty sheet.
   */
  let exported = rows;
  let periodLabel = "all time";
  let groupingIndex = 0;
  // The money-out registers carry the same week window the screen is showing.
  // Without it the CSV quietly covered all time while Mary was looking at one
  // week — and she exports it precisely to match that week against SF.
  const rawPeriod = req.nextUrl.searchParams.get("period");
  if (isSpendPeriod(rawPeriod) && rawPeriod !== "all") {
    exported = filterToSpendPeriod(
      exported as unknown as { ymd: string | null }[],
      rawPeriod,
    ) as typeof exported;
    periodLabel = spendPeriodLabel(rawPeriod);
  }
  if (view === "ar") {
    const cutoff = arPeriodCutoff(req.nextUrl.searchParams.get("arperiod") ?? "all");
    if (cutoff) exported = rows.filter((r) => !r.issuedYmd || r.issuedYmd >= cutoff);
    periodLabel =
      AR_PERIODS.find((p) => p.key === (req.nextUrl.searchParams.get("arperiod") ?? "all"))?.label ?? "all time";
    const g = Number(req.nextUrl.searchParams.get("argroup") ?? "0");
    if (Number.isInteger(g) && g >= 0 && g < AR_APPLICATIONS_SPEC.groupings.length) groupingIndex = g;
  }

  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return csvResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groupedReportCsv(sheet.spec as any, exported, groupingIndex),
    `${sheet.file}_${day}.csv`,
    sheet.title,
    periodLabel
  );
}
