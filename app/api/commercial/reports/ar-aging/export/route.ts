import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { arAgingCsv } from "@/lib/commercial/reports/ar-aging-csv";
import { etTodayIso } from "@/lib/date-et";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await guardExport({ report: "ar-aging" });
  if (!guard.ok) return guard.response;

  const aging = await getArAging();
  // The sheet itself — headers, rows, totals and the no-due-date caveat — is
  // built in lib/commercial/reports/ar-aging-csv.ts, which is pure, so the
  // file is tested as bytes rather than read off this route.
  const body = arAgingCsv(aging);
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `AR_Aging_${today}.csv`, "AR Aging — open invoices and AIA applications by age");
}
