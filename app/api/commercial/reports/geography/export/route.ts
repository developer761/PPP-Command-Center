import { getGeographyReport, type GeoRow } from "@/lib/commercial/reports/geography";
import { etTodayIso } from "@/lib/date-et";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (cents: number) => (cents / 100).toFixed(2);

export async function GET() {
  const guard = await guardExport({ report: "geography" });
  if (!guard.ok) return guard.response;

  const geo = await getGeographyReport();
  const header = ["Grouping", "Location", "Detail", "Jobs", "Contract", "Total cost", "Margin", "Margin %"];
  const line = (grouping: string, r: GeoRow) =>
    [grouping, r.label, r.sub ?? "", r.dealCount, money(r.contractCents), money(r.totalCostCents), money(r.marginCents), r.marginPct === null ? "" : String(r.marginPct)]
      .map(csv)
      .join(",");
  const lines = [
    ...geo.byCity.map((r) => line("City", r)),
    ...geo.byZip.map((r) => line("Zip", r)),
    ...geo.byState.map((r) => line("State", r)),
  ];
  const body = [header.map(csv).join(","), ...lines].join("\r\n") + "\r\n";
  const today = etTodayIso();
  // Shared helper: consistent headers AND the UTF-8 BOM Excel needs.
  return csvResponse(body, `Geography_${today}.csv`, "Geography — work by area");
}
