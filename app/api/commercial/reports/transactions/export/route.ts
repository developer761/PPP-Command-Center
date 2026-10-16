import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getTransactionsReport, type TxnDirection, type TxnFilters } from "@/lib/commercial/reports/transactions";
import { transactionsCsv, transactionsFilename } from "@/lib/commercial/reports/transactions-export";
import { ACTIVITY_PRESETS, LEDGER_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ledger as a file — Alex's report, exported.
 *
 * Reads the SAME query keys the Accounting page's Transactions view uses, so
 * the download is exactly the slice on screen. A month that ties out on the
 * page and not in the spreadsheet is invisible until somebody's reconciliation
 * fails, which is the worst possible place to find it.
 *
 * Gated to the Accounting roles. It used to say it followed "the same rule as
 * the receivables and AR exports" while passing no options at all — which
 * admits any signed-in non-crew user, so a rep could fetch the entire
 * money-in/money-out ledger straight from the URL.
 */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ accounting: true });
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  /*
   * 🔴 THE SAME DEFAULT AS THE SCREEN THAT LINKS HERE.
   *
   * This fell back to ACTIVITY_DEFAULT ("all") while the Accounting page runs
   * on LEDGER_DEFAULT ("this month") and — correctly — omits `tp` from the URL
   * when it is at its own default. So "Export for filing" from a screen
   * showing ONE MONTH produced a file covering everything.
   *
   * Measured 2026-10-16. Sales tax: screen 1 invoice / $0.00; file 74 invoices
   * / $9,267.15 spanning Aug 2025 to Oct 2026. Ledger: screen 129 rows / net
   * -$59,245.58; file 1,977 rows / net +$369,496.40 — the sign flips. This is
   * the file that goes to the accountant to file from.
   *
   * The Accounting page is the only caller of this route (grepped), so there
   * is no second consumer relying on "all".
   */
  const period = resolvePreset(sp.get("tp") ?? undefined, ACTIVITY_PRESETS, LEDGER_DEFAULT);
  const range = activityRange(period);
  const rawDir = sp.get("td");
  const direction: TxnDirection | undefined =
    rawDir === "in" || rawDir === "out" ? rawDir : undefined;
  const filters: TxnFilters = {
    fromYmd: range?.fromYmd,
    toYmd: range?.toYmd,
    direction,
    party: sp.get("tparty")?.trim() || undefined,
    undepositedOnly: sp.get("tundep") === "1" || undefined,
  };

  const report = await getTransactionsReport(filters);
  return csvResponse(transactionsCsv(report), transactionsFilename(period), "Transactions — money in and out, by month", range?.label ?? "all time");
}
