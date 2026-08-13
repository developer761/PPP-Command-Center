import { describe, it, expect } from "vitest";
import { columnKeyForOpp } from "@/lib/commercial/opportunities/kanban-columns";

/**
 * Estimator report — the judgement calls, pinned.
 *
 * Every one of these is a way the number could look right and be wrong, which
 * is worse than a number that's obviously broken. The aggregation itself needs
 * a database; these cover the rules that decide what the aggregation MEANS,
 * mirrored exactly from lib/commercial/reports/estimator.ts.
 */

/** Whole days between two ET calendar dates — the turnaround measure. */
function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Win rate over DECIDED bids only. */
function winRate(won: number, lost: number): number | null {
  const decided = won + lost;
  return decided > 0 ? Math.round((won / decided) * 100) : null;
}

describe("turnaround", () => {
  it("counts calendar days and survives DST", () => {
    expect(daysBetween("2026-08-03", "2026-08-12")).toBe(9);
    // Spring forward sits inside this window; a UTC-hours divide gives 6.958.
    expect(daysBetween("2026-03-02", "2026-03-09")).toBe(7);
  });

  it("same day is 0, not 1 — a bid sent the day it arrived is same-day", () => {
    expect(daysBetween("2026-08-12", "2026-08-12")).toBe(0);
  });

  it("goes negative when a send predates the RFP, which is why that case is excluded", () => {
    // Real data has typos. Averaging a −40 in would quietly pull the whole
    // team's turnaround down and look like an improvement.
    expect(daysBetween("2026-08-12", "2026-07-03")).toBeLessThan(0);
  });
});

describe("win rate counts decided bids only", () => {
  it("an open bid is not a loss", () => {
    // 2 won, 0 lost, 8 still out. Counting opens gives 20% and says the
    // estimator is failing at nothing.
    expect(winRate(2, 0)).toBe(100);
  });

  it("is null — never 0% — when nothing has been decided", () => {
    // 0% reads as "lost everything". Null reads as "too early", which is true.
    expect(winRate(0, 0)).toBeNull();
  });

  it("rounds to whole percent", () => {
    expect(winRate(1, 2)).toBe(33);
    expect(winRate(2, 1)).toBe(67);
  });

  it("a loss-only record is 0%, which is real and must show", () => {
    expect(winRate(0, 4)).toBe(0);
  });
});

describe("what counts as one bid", () => {
  /** Fold proposal rows to one bid per deal — earliest send, newest value. */
  function foldBids(rows: { opp: string; rev: number; sent: string; cents: number }[]) {
    const m = new Map<string, { firstSent: string; latestRev: number; cents: number }>();
    for (const p of rows) {
      const cur = m.get(p.opp);
      if (!cur) { m.set(p.opp, { firstSent: p.sent, latestRev: p.rev, cents: p.cents }); continue; }
      if (p.sent < cur.firstSent) cur.firstSent = p.sent;
      if (p.rev >= cur.latestRev) { cur.latestRev = p.rev; cur.cents = p.cents; }
    }
    return m;
  }

  it("five revisions of one proposal are ONE bid", () => {
    const bids = foldBids([
      { opp: "o1", rev: 1, sent: "2026-07-01", cents: 100_00 },
      { opp: "o1", rev: 2, sent: "2026-08-01", cents: 200_00 },
      { opp: "o1", rev: 3, sent: "2026-09-01", cents: 300_00 },
    ]);
    expect(bids.size).toBe(1);
  });

  it("turnaround uses the FIRST send — a revision months later isn't a slow bid", () => {
    const b = foldBids([
      { opp: "o1", rev: 2, sent: "2026-10-01", cents: 200_00 },
      { opp: "o1", rev: 1, sent: "2026-07-01", cents: 100_00 },
    ]).get("o1")!;
    expect(b.firstSent).toBe("2026-07-01");
  });

  it("value uses the NEWEST revision — what the GC is actually holding", () => {
    const b = foldBids([
      { opp: "o1", rev: 1, sent: "2026-07-01", cents: 100_00 },
      { opp: "o1", rev: 2, sent: "2026-08-01", cents: 250_00 },
    ]).get("o1")!;
    expect(b.cents).toBe(250_00);
  });

  it("rows arriving out of order still fold correctly", () => {
    const b = foldBids([
      { opp: "o1", rev: 3, sent: "2026-09-01", cents: 300_00 },
      { opp: "o1", rev: 1, sent: "2026-06-01", cents: 100_00 },
      { opp: "o1", rev: 2, sent: "2026-07-01", cents: 200_00 },
    ]).get("o1")!;
    expect(b.firstSent).toBe("2026-06-01");
    expect(b.cents).toBe(300_00);
  });
});

describe("a won deal is won however its proposal was left", () => {
  // Uses the SHARED mapper, not a local copy — writing the tuple test out
  // again is how the same deal reads won on one screen and open on another.
  const wonStatuses = ["pre_construction", "in_progress", "billing", "post_sale_closed"];
  function outcome(status: string, sub: string | null): "won" | "lost" | "open" {
    const col = columnKeyForOpp(status, sub);
    if (col === "won" || wonStatuses.includes(status)) return "won";
    if (col === "lost") return "lost";
    return "open";
  }

  it("reads the DEAL, so a stale 'sent' proposal on a won job still counts as a win", () => {
    expect(outcome("pre_sale_closed", "won")).toBe("won");
    for (const s of wonStatuses) expect(outcome(s, null), s).toBe("won");
  });

  it("a bid still with the GC is open, not lost", () => {
    expect(outcome("proposal", "sent")).toBe("open");
    expect(outcome("qualifying", "rfp")).toBe("open");
  });

  it("only an explicit lost is a loss", () => {
    expect(outcome("pre_sale_closed", "lost")).toBe("lost");
    // A junk sub-status reads as Lost, matching the board exactly — that call
    // exists so a hand-edited row can never inflate the won column.
    expect(outcome("pre_sale_closed", "garbage")).toBe("lost");
  });
});
