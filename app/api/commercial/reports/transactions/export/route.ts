import type { NextRequest } from "next/server";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getTransactionsReport, type TxnDirection, type TxnFilters } from "@/lib/commercial/reports/transactions";
import { transactionsCsv, transactionsFilename } from "@/lib/commercial/reports/transactions-export";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";

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
 * Gated with `people: false` — this is company money, not per-person pay, so it
 * follows the same rule as the receivables and AR exports.
 */
export async function GET(req: NextRequest) {
  const guard = await guardExport();
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const period = resolvePreset(sp.get("tp") ?? undefined, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
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
  return csvResponse(transactionsCsv(report), transactionsFilename(period));
}
