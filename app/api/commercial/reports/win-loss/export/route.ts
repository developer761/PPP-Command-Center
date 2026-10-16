import type { NextRequest } from "next/server";
import {
  getWinLossRecords, summarizeWinLoss, getCompetitorBreakdown, getDecidingFactorBreakdown, getLessonsLearnedFeed,
} from "@/lib/commercial/win-loss/reports";
import { parseRange } from "@/lib/commercial/win-loss/range";
import { winLossCsv } from "@/lib/commercial/win-loss/export-csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Win / loss — Alex's quarterly-review sheet. Honours the same ?preset= or
 *  ?from=&to= the page does, through the same parser, so the file and the
 *  screen cover the identical window. The sheet itself is built in
 *  lib/commercial/win-loss/export-csv.ts. */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "win-loss" });
  if (!guard.ok) return guard.response;

  const q = req.nextUrl.searchParams;
  const asked = { from: q.get("from"), to: q.get("to") };
  const range = parseRange({
    from: asked.from ?? undefined,
    to: asked.to ?? undefined,
    preset: q.get("preset") ?? undefined,
  });
  const [records, competitors, factors, lessons] = await Promise.all([
    getWinLossRecords(range),
    getCompetitorBreakdown(range, 100),
    getDecidingFactorBreakdown(range),
    // The review sheet wants the whole feed, not the page's top-20 preview.
    getLessonsLearnedFeed(range, 500),
  ]);
  const summary = summarizeWinLoss(records);

  const body = winLossCsv({ range, asked, summary, records, competitors, factors, lessons });
  return csvResponse(body, `Win_Loss_${range.fromYmd}_to_${range.toYmd}.csv`, "Win / loss", range.label);
}
