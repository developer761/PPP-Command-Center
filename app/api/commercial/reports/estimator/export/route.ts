import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { getEstimatorReport } from "@/lib/commercial/reports/estimator";
import {
  ESTIMATOR_PRESETS, ESTIMATOR_DEFAULT, estimatorRange, resolvePreset, fiscalYearStartMonth,
} from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);

/** Estimator performance. Admin / account manager only — per-person numbers,
 *  same gate the page enforces, so the URL isn't a way around the redirect. */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ people: true });
  if (!guard.ok) return guard.response;

  const preset = resolvePreset(
    req.nextUrl.searchParams.get("preset") ?? undefined,
    ESTIMATOR_PRESETS,
    ESTIMATOR_DEFAULT
  );
  const range = estimatorRange(preset, await fiscalYearStartMonth());
  const r = await getEstimatorReport(range);

  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Estimator performance", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("Estimator", "Bids sent", "Bid value", "Won", "Lost", "Open", "Won value", "Win rate %", "Avg turnaround (days)", "Turnaround sample");
  for (const e of r.rows) {
    row(e.name, e.bidsSent, money(e.bidValueCents), e.won, e.lost, e.open, money(e.wonValueCents),
        e.winRatePct ?? "", e.avgTurnaroundDays ?? "", e.turnaroundSample);
  }
  const t = r.totals;
  row("ALL", t.bidsSent, money(t.bidValueCents), t.won, t.lost, t.open, money(t.wonValueCents),
      t.winRatePct ?? "", t.avgTurnaroundDays ?? "", t.turnaroundSample);

  if (r.missingRfpDate > 0 || r.sentBeforeRfp > 0) {
    row("");
    row("DATA NOTES");
    // Turnaround is an average over a subset; saying which bids fell out of it
    // stops the figure reading as more complete than it is.
    if (r.missingRfpDate > 0) row("Bids with no RFP-received date (turnaround not measurable)", r.missingRfpDate);
    if (r.sentBeforeRfp > 0) row("Bids sent before the RFP arrived (data-entry error, excluded)", r.sentBeforeRfp);
  }

  return csvResponse(L.join("\r\n") + "\r\n", `Estimator_${range.fromYmd}_to_${range.toYmd}.csv`);
}
