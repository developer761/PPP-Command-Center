import { describe, it, expect } from "vitest";

import { summarizeWinLoss, type WinLossRecord } from "@/lib/commercial/win-loss/reports";
import { WIN_LOSS_SPEC } from "@/lib/commercial/reports/tomco/win-loss-spec";
import { buildGroups, grandTotals, type GroupNode } from "@/lib/commercial/reports/grouped/spec";

/**
 * The table and the gauge above it are the same set.
 *
 * This file's own history is the reason to pin it: `lib/commercial/win-loss/
 * reports.ts` carries three separate comments about surfaces that drifted
 * apart on the question "what counts as won" — the dashboard tile and this
 * report disagreed on the date field, on debrief-gating, and on whether a win
 * stays won once it moves into delivery. Each was found by somebody tapping a
 * number and landing on a report showing a different one.
 *
 * So the records are now the single source and the summary is folded from
 * them. These tests hold that: the same rows, counted two ways, must agree —
 * and must keep agreeing however the report is grouped.
 */

const rec = (p: Partial<WinLossRecord> & Pick<WinLossRecord, "oppId" | "outcome">): WinLossRecord => ({
  name: `Job ${p.oppId}`,
  accountName: "Acme GC",
  valueCents: 0,
  decidedYmd: "2026-06-01",
  lossReason: null,
  competitor: null,
  decidingFactor: null,
  ...p,
});

// Deliberately NOT in outcome order. `buildGroups` returns groups in the order
// it first meets them, so a sample that already reads Won/Lost/No bid would
// pass whether or not the spec's `sortBy` did anything — which is exactly how
// the first version of this test passed while `sortBy` was dead code.
const SAMPLE: WinLossRecord[] = [
  rec({ oppId: "5", outcome: "no_bid" }),
  rec({ oppId: "3", outcome: "lost", valueCents: 400_000, lossReason: "Price" }),
  rec({ oppId: "1", outcome: "won", valueCents: 100_000 }),
  rec({ oppId: "4", outcome: "lost", valueCents: 50_000, lossReason: "Schedule", accountName: "Bannett" }),
  rec({ oppId: "2", outcome: "won", valueCents: 250_000, accountName: "Bannett" }),
];

describe("the summary is the records, folded", () => {
  it("counts and money come out of the same rows", () => {
    const s = summarizeWinLoss(SAMPLE);
    expect(s.wonCount).toBe(2);
    expect(s.lostCount).toBe(2);
    expect(s.noBidCount).toBe(1);
    expect(s.wonValueCents).toBe(350_000);
    expect(s.lostValueCents).toBe(450_000);
  });

  it("a no-bid is not a loss — it stays out of the rate", () => {
    // Two won, two lost → 50%. The no-bid must not drag it to 40%.
    expect(summarizeWinLoss(SAMPLE).winRatePct).toBe(50);
    expect(summarizeWinLoss(SAMPLE).totalClosed).toBe(5);
  });

  it("a period with nothing decided reports 0%, not NaN", () => {
    const s = summarizeWinLoss([]);
    expect(s.winRatePct).toBe(0);
    expect(s.totalClosed).toBe(0);
  });

  it("wins with no losses still read 100 — the page guards that, not this", () => {
    // Tomco's migration brought 92 won jobs and no lost bids. The arithmetic
    // here is honest; suppressing it belongs on the surface that renders it.
    expect(summarizeWinLoss([rec({ oppId: "1", outcome: "won", valueCents: 1 })]).winRatePct).toBe(100);
  });
});

describe("the table agrees with the summary, in every grouping", () => {
  const s = summarizeWinLoss(SAMPLE);

  it("the report's own totals match the folded summary", () => {
    const byLabel = new Map(WIN_LOSS_SPEC.totals.map((t) => [t.label, t.value(SAMPLE)]));
    expect(byLabel.get("Won")).toBe(350_000);
    expect(byLabel.get("Won")).toBe(s.wonValueCents);
    expect(byLabel.get("Lost")).toBe(s.lostValueCents);
    expect(byLabel.get("Decided")).toBe(s.wonCount + s.lostCount);
    expect(byLabel.get("No bid")).toBe(s.noBidCount);
    // And the Value column's grand total is every deal's money.
    const gt = grandTotals(SAMPLE, WIN_LOSS_SPEC.columns);
    expect(gt.value).toBe(s.wonValueCents + s.lostValueCents);
  });

  it("every grouping shows all the records and the same money", () => {
    const totalMoney = SAMPLE.reduce((n, r) => n + r.valueCents, 0);
    WIN_LOSS_SPEC.groupings.forEach((g, i) => {
      const groups = buildGroups(SAMPLE, g, WIN_LOSS_SPEC.columns);
      const rows = groups.reduce((n, g) => n + countRows(g), 0);
      const money = sumRows(groups).reduce((n, r) => n + r.valueCents, 0);
      expect(rows, `grouping ${i} dropped a record`).toBe(SAMPLE.length);
      expect(money, `grouping ${i} changed the money`).toBe(totalMoney);
    });
  });

  it("the Lost total is losses only, never 'everything that is not a win'", () => {
    // A no-bid with money on it is impossible from the database (getWinLossRecords
    // zeroes it), so the guard has to be tested on the spec itself — otherwise a
    // filter of `!== "won"` reads identically and ships.
    const withPricedNoBid = [...SAMPLE, rec({ oppId: "6", outcome: "no_bid", valueCents: 999_000 })];
    const lost = WIN_LOSS_SPEC.totals.find((t) => t.label === "Lost")!;
    expect(lost.value(withPricedNoBid)).toBe(450_000);
  });

  it("Won sorts above Lost above No bid, whatever the alphabet says", () => {
    const groups = buildGroups(SAMPLE, WIN_LOSS_SPEC.groupings[0], WIN_LOSS_SPEC.columns);
    expect(groups.map((g) => g.label)).toEqual(["Won", "Lost", "No bid"]);
  });

  it("a win has no loss reason, so grouping by reason keeps it under the blank", () => {
    const groups = buildGroups(SAMPLE, WIN_LOSS_SPEC.groupings[2], WIN_LOSS_SPEC.columns);
    const blank = groups.find((g) => g.label === "" || g.label === "—");
    expect(blank, "wins must still appear when grouped by why we lost").toBeTruthy();
    expect(countRows(blank!)).toBe(3); // two wins + the no-bid
  });
});

/** Rows in a group, however deep the spec nests them. */
function countRows(g: GroupNode<WinLossRecord>): number {
  if (g.children.length) return g.children.reduce((n, c) => n + countRows(c), 0);
  return g.rows.length;
}
function sumRows(groups: GroupNode<WinLossRecord>[]): WinLossRecord[] {
  const out: WinLossRecord[] = [];
  for (const g of groups) {
    if (g.children.length) out.push(...sumRows(g.children));
    else out.push(...g.rows);
  }
  return out;
}
