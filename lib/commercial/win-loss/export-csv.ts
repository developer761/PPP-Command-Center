import { csvEscape as csv } from "@/lib/commercial/csv";
import type {
  CompetitorBreakdown, DecidingFactorBreakdown, LessonRow, WinLossRecord, WinLossSummary,
} from "@/lib/commercial/win-loss/reports";
import type { parseRange } from "@/lib/commercial/win-loss/range";

const money = (c: number) => (c / 100).toFixed(2);

export type WinLossCsvInput = {
  range: ReturnType<typeof parseRange>;
  /** The from/to that were on the URL — what the reader ASKED for. */
  asked: { from?: string | null; to?: string | null };
  summary: WinLossSummary;
  records: WinLossRecord[];
  competitors: CompetitorBreakdown[];
  factors: DecidingFactorBreakdown[];
  lessons: LessonRow[];
};

/**
 * Win / loss — Alex's quarterly-review sheet, as bytes (title block and BOM
 * are added by `csvResponse`). Pure so the file is tested, not the route.
 */
export function winLossCsv({ range, asked, summary, records, competitors, factors, lessons }: WinLossCsvInput): string {
  const L: string[] = [];
  const row = (...cells: (string | number)[]) => L.push(cells.map(csv).join(","));

  row("Win / loss", range.label);
  /*
   * A RANGE WE COULD NOT USE IS SAID, NOT SWAPPED.
   *
   * `parseRange` falls back to this quarter when the custom dates are invalid
   * (a year before 1970, `to` before `from`, a malformed date) and flags it
   * `rejected`. The page prints a red hint; the file printed nothing, so a
   * sheet asked for 1900 came back as this quarter's 100% win rate with no
   * sign that it answered a different question. The filename and the title
   * block do name the real window — but only to a reader who compares them
   * against what they typed.
   */
  if (range.rejected) {
    const wanted = [asked.from || "?", asked.to || "?"].join(" to ");
    row(`NOTE: the range asked for (${wanted}) is not a valid date range, so this file covers ${range.label} instead.`);
  }
  row("");
  row("Decided deals", summary.totalClosed);
  row("Won", summary.wonCount, money(summary.wonValueCents));
  row("Lost", summary.lostCount, money(summary.lostValueCents));
  // No-bids are excluded from the rate on purpose — declining to bid isn't
  // losing, and folding them in would understate the win rate.
  row("No bid", summary.noBidCount);
  row("Win rate %", summary.winRatePct, "won / (won + lost), excludes no-bid");
  row("");

  // THE DEALS THEMSELVES, first.
  //
  // The sheet opened with four totals and went straight to competitor counts:
  // a reviewer could see 38% and never find out which deals made it up. These
  // are the same rows the page now shows, from the same read, so the file and
  // the screen cannot disagree.
  row("DECIDED DEALS");
  row("Opportunity", "GC", "Outcome", "Value", "Decided", "Reason", "Lost to");
  for (const r of records) {
    row(
      r.name,
      r.accountName,
      r.outcome === "won" ? "Won" : r.outcome === "lost" ? "Lost" : "No bid",
      money(r.valueCents),
      r.decidedYmd ?? "",
      r.lossReason ?? "",
      r.competitor ?? ""
    );
  }
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

  return L.join("\r\n") + "\r\n";
}
