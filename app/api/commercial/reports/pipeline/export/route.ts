import { getPipelineReport } from "@/lib/commercial/reports/pipeline";
import { etTodayIso } from "@/lib/date-et";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (cents: number) => (cents / 100).toFixed(2);

export async function GET() {
  const guard = await guardExport({ report: "pipeline" });
  if (!guard.ok) return guard.response;

  const report = await getPipelineReport();
  const header = ["Stage", "Opportunities", "Bid value", "Weighted value"];
  const lines = report.rows.map((r) => [r.label, r.count, money(r.bidCents), money(r.weightedCents)].map(csv).join(","));
  const totals = ["All open", report.totals.count, money(report.totals.bidCents), money(report.totals.weightedCents)].map(csv).join(",");
  const body = [header.map(csv).join(","), ...lines, totals].join("\r\n") + "\r\n";
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `Pipeline_${today}.csv`, "Pipeline — open opportunities by stage");
}
