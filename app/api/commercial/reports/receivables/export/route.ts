import type { NextRequest } from "next/server";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { receivablesCsv, receivablesFilename } from "@/lib/commercial/reports/receivables-export";
import { parseReceivableQuery, filtersFor, describeReceivableQuery } from "@/lib/commercial/reports/receivables-filters";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The receivables sheet as a CSV — Mary's export.
 *
 * Same columns, same order, same total as the page, because it replaces the
 * spreadsheet she keeps by hand: if the export didn't tie out with the screen
 * she'd keep the spreadsheet and we'd have built nothing.
 *
 * The body is built by a shared helper rather than inline, so the file she
 * downloads and the file attached to Alex's email are byte-identical.
 */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "receivables", orAccounting: true });
  if (!guard.ok) return guard.response;

  // Same parser the page uses, so the file is exactly the slice on screen.
  const q = parseReceivableQuery((k) => req.nextUrl.searchParams.get(k));
  const report = await getReceivablesReport(Date.now(), filtersFor(q));
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  // The window/filter is stated ONCE, in the title block — so the body is
  // built without its own banner here.
  return csvResponse(
    receivablesCsv(report),
    receivablesFilename(q.period),
    "Receivables — every job with money out",
    describeReceivableQuery(q) ?? "all time"
  );
}
