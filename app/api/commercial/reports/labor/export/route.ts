import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { getLaborReport } from "@/lib/commercial/reports/labor";
import { LABOR_PRESETS, LABOR_DEFAULT, laborRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);
const hrs = (h: number) => h.toFixed(2);

/** Labour & payroll. Admin / account manager only — this is per-person pay. */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ people: true });
  if (!guard.ok) return guard.response;

  const preset = resolvePreset(
    req.nextUrl.searchParams.get("preset") ?? undefined,
    LABOR_PRESETS,
    LABOR_DEFAULT
  );
  const range = laborRange(preset);
  const r = await getLaborReport(range);

  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Labour & payroll", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("Total hours", hrs(r.totalHours));
  row("Total cost", money(r.totalCostCents));
  // The honesty line. Unpriced hours understate cost, which overstates margin
  // everywhere downstream — it belongs in the file, not just on the screen.
  row("Unpriced hours", hrs(r.unratedHours));
  if (r.unratedPeople.length > 0) row("People with no cost rate", r.unratedPeople.join("; "));
  row("");

  row("BY PERSON");
  row("Person", "Hours", "Priced hours", "Unpriced hours", "Cost", "Jobs");
  for (const p of r.people) {
    row(p.name, hrs(p.hours), hrs(p.ratedHours), hrs(p.unratedHours), money(p.costCents), p.jobCount);
  }
  row("");

  row("BY JOB");
  row("Job", "Hours", "Unpriced hours", "Cost", "Crew");
  for (const j of r.jobs) row(j.jobName, hrs(j.hours), hrs(j.unratedHours), money(j.costCents), j.crewCount);
  row("");

  row("BY WEEK");
  row("Week starting", "Hours", "Cost");
  for (const w of r.weeks) row(w.weekStart, hrs(w.hours), money(w.costCents));

  return csvResponse(L.join("\r\n") + "\r\n", `Labour_${range.fromYmd}_to_${range.toYmd}.csv`);
}
