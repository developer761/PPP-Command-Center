import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { groupedReportCsv } from "@/lib/commercial/reports/grouped/csv";
import { getArSheetRows, AR_APPLICATIONS_SPEC } from "@/lib/commercial/reports/tomco/ar-applications";
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
const SHEETS = {
  ar: { title: "Accounts Receivable", file: "AR_sheet", load: getArSheetRows, spec: AR_APPLICATIONS_SPEC },
  owed: { title: "Balance Owed", file: "Balance_owed", load: getBalanceOwedRows, spec: BALANCE_OWED_SPEC },
  purchases: {
    title: "Purchases by vendor",
    file: "Purchases",
    load: async () => purchaseRows(await getSpendRows()),
    spec: PURCHASES_BY_VENDOR_SPEC,
  },
  "labor-out": {
    title: "Labor payments out",
    file: "Labor_payments",
    load: async () => laborPaymentRows(await getSpendRows()),
    spec: LABOR_PAYMENTS_SPEC,
  },
  deposits: { title: "Partner deposit history", file: "Deposits", load: getMoneyInRows, spec: DEPOSIT_HISTORY_SPEC },
} as const;

export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "receivables", orAccounting: true });
  if (!guard.ok) return guard.response;

  const view = req.nextUrl.searchParams.get("view") ?? "";
  const sheet = (SHEETS as Record<string, (typeof SHEETS)[keyof typeof SHEETS] | undefined>)[view];
  if (!sheet) {
    return new Response(`Nothing to export for "${view}".`, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each sheet
  // pairs its own loader with its own spec; the union is correct per key but
  // not expressible across the lookup.
  const rows = (await sheet.load()) as any[];
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return csvResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groupedReportCsv(sheet.spec as any, rows),
    `${sheet.file}_${day}.csv`,
    sheet.title,
    "all time"
  );
}
