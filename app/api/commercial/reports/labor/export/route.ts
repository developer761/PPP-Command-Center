import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { getLaborReport } from "@/lib/commercial/reports/labor";
import { LABOR_PRESETS, LABOR_DEFAULT, laborRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);
const hrs = (h: number) => h.toFixed(2);

/** Labor & payroll. Admin / account manager only — this is per-person pay. */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "labor", people: true });
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

  row("Labor & payroll", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("Total hours", hrs(r.totalHours));
  // Two separate accounts of the same work, on two lines, never summed — see
  // lib/commercial/reports/labor.ts. For Tomco the payroll line is 0 and the
  // payout line is the whole story.
  row("Paid out to crews", money(r.payoutCents));
  row("Payroll cost (W-2)", money(r.totalCostCents));
  // The honesty line. Unpriced hours understate cost, which overstates margin
  // everywhere downstream — it belongs in the file, not just on the screen.
  row("Unpriced hours", hrs(r.unratedHours));
  if (r.unratedPeople.length > 0) row("People with no cost rate", r.unratedPeople.join("; "));
  row("");

  row("PAID OUT TO CREWS");
  row("Crew", "Paid", "Payments", "Jobs");
  for (const p of r.payouts) row(p.vendor, money(p.amountCents), p.count, p.jobCount);
  row("");

  row("BY PERSON");
  row("Person", "Paid via", "Hours", "Priced hours", "Unpriced hours", "Payroll cost", "Jobs");
  for (const p of r.people) {
    row(
      p.name,
      p.isSub ? "Crew payout" : "Payroll",
      hrs(p.hours),
      hrs(p.ratedHours),
      hrs(p.unratedHours),
      money(p.costCents),
      p.jobCount
    );
  }
  row("");

  row("BY JOB");
  row("Job", "Hours", "Unpriced hours", "Paid out", "Payroll cost", "Crew");
  for (const j of r.jobs) {
    row(j.jobName, hrs(j.hours), hrs(j.unratedHours), money(j.payoutCents), money(j.costCents), j.crewCount);
  }
  row("");

  row("BY WEEK");
  row("Week starting", "Hours", "Payroll cost");
  for (const w of r.weeks) row(w.weekStart, hrs(w.hours), money(w.costCents));

  return csvResponse(
    L.join("\r\n") + "\r\n",
    `Labor_${range.fromYmd}_to_${range.toYmd}.csv`,
    "Labor — hours and what was paid",
    range.label
  );
}
