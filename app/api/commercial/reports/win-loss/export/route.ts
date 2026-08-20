import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import {
  getWinLossSummary, getCompetitorBreakdown, getDecidingFactorBreakdown, getLessonsLearnedFeed,
} from "@/lib/commercial/win-loss/reports";
import { parseRange } from "@/lib/commercial/win-loss/range";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const money = (c: number) => (c / 100).toFixed(2);

/** Win / loss — Alex's quarterly-review sheet. Honours the same ?preset= or
 *  ?from=&to= the page does, through the same parser, so the file and the
 *  screen cover the identical window. */
export async function GET(req: NextRequest) {
  const guard = await guardExport();
  if (!guard.ok) return guard.response;

  const q = req.nextUrl.searchParams;
  const range = parseRange({
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    preset: q.get("preset") ?? undefined,
  });
  const [summary, competitors, factors, lessons] = await Promise.all([
    getWinLossSummary(range),
    getCompetitorBreakdown(range, 100),
    getDecidingFactorBreakdown(range),
    // The review sheet wants the whole feed, not the page's top-20 preview.
    getLessonsLearnedFeed(range, 500),
  ]);

  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Win / loss", range.label);
  row("");
  row("Decided deals", summary.totalClosed);
  row("Won", summary.wonCount, money(summary.wonValueCents));
  row("Lost", summary.lostCount, money(summary.lostValueCents));
  // No-bids are excluded from the rate on purpose — declining to bid isn't
  // losing, and folding them in would understate the win rate.
  row("No bid", summary.noBidCount);
  row("Win rate %", summary.winRatePct, "won / (won + lost), excludes no-bid");
  row("");

  row("COMPETITORS");
  row("Competitor", "Lost to them", "Won against them", "Total");
  for (const c of competitors) row(c.competitor_name, c.lost_count, c.won_count, c.total_count);
  row("");

  row("DECIDING FACTORS");
  row("Factor", "Count");
  for (const f of factors) row(f.deciding_factor, f.count);
  row("");

  row("LESSONS LEARNED");
  row("Opportunity", "Outcome", "Competitor", "Deciding factor", "Lessons");
  for (const l of lessons) {
    row(l.opportunity_title, l.outcome, l.competitor_name ?? "", l.deciding_factor ?? "", l.lessons_learned);
  }

  return csvResponse(L.join("\r\n") + "\r\n", `Win_Loss_${range.fromYmd}_to_${range.toYmd}.csv`, "Win / loss", range.label);
}
