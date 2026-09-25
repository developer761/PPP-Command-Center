import { describe, it, expect } from "vitest";

import {
  summarizeWinLoss,
  hadHeadToHead,
  wonValueRatioPct,
  type WinLossRecord,
} from "@/lib/commercial/win-loss/reports";
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

  /**
   * EVERY GROUP UNDER "WHY WE LOST" IS NAMED.
   *
   * A win has no loss reason, and it is not dropped — the subtotals have to
   * keep adding up to the same money however the report is grouped. But the
   * wins used to fall under the empty string, which renders as an em-dash. On
   * a quarter with twelve wins and no losses, pressing "Why we lost" gave
   * Brendan one group headed "— (12)" holding every deal he had WON.
   *
   * The bucket was honest about having no reason and silent about what was in
   * it, which is the worse half.
   */
  it("keeps wins and no-bids in the reason view, in named buckets", () => {
    const groups = buildGroups(SAMPLE, WIN_LOSS_SPEC.groupings[2], WIN_LOSS_SPEC.columns);
    const labels = groups.map((g) => g.label);
    expect(labels, "no group may be blank under Why we lost").not.toContain("");
    expect(labels).toContain("Won — no loss reason");
    expect(labels).toContain("No bid — we passed");

    const won = groups.find((g) => g.label === "Won — no loss reason")!;
    const noBid = groups.find((g) => g.label === "No bid — we passed")!;
    expect(countRows(won)).toBe(2);
    expect(countRows(noBid)).toBe(1);
  });

  it("names a loss whose reason nobody recorded, rather than blanking it", () => {
    const groups = buildGroups(
      [...SAMPLE, rec({ oppId: "6", outcome: "lost", valueCents: 1_000, lossReason: null })],
      WIN_LOSS_SPEC.groupings[2],
      WIN_LOSS_SPEC.columns,
    );
    expect(groups.map((g) => g.label)).toContain("Lost — no reason recorded");
  });

  it("sorts real reasons above the buckets that are not losses", () => {
    // This view exists for the reasons; Won and No bid are only there so the
    // totals reconcile, so they belong at the bottom.
    const labels = buildGroups(SAMPLE, WIN_LOSS_SPEC.groupings[2], WIN_LOSS_SPEC.columns).map(
      (g) => g.label,
    );
    expect(labels.indexOf("Price")).toBeLessThan(labels.indexOf("Won — no loss reason"));
    expect(labels.indexOf("Schedule")).toBeLessThan(labels.indexOf("Won — no loss reason"));
    expect(labels.indexOf("Won — no loss reason")).toBeLessThan(
      labels.indexOf("No bid — we passed"),
    );
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

/**
 * Neither headline ratio may answer when there is nothing to compare against.
 *
 * The two tiles sit side by side and disagreed off the SAME rows. "Win rate"
 * was fixed when Tomco's migration brought in 92 won jobs and no lost bids —
 * the comment in the page still describes it — but "$ won ratio" was guarded
 * only against a zero denominator, so with wins and no losses it printed a
 * confident 100% "of every $ we bid on". On 2026-09-25 the live report read
 * "—  ·  none lost on record" and "100%" next to each other.
 *
 * That is the shape of every partial guard: the case was understood, and
 * narrowing it in one place left the other reading like a clean sweep. Alex
 * reads these at the quarterly review, and 100% is what gets quoted.
 *
 * Pinned on the PREDICATES, not the JSX, so a tile rewrite cannot quietly
 * reintroduce it.
 */
describe("a ratio with nothing on the other side", () => {
  const won = (cents: number) => rec({ oppId: `w${cents}`, outcome: "won", valueCents: cents });
  const lost = (cents: number) => rec({ oppId: `l${cents}`, outcome: "lost", valueCents: cents });

  it("refuses both ratios when nothing has been lost — Tomco's live state", () => {
    const s = summarizeWinLoss([won(100_00), won(900_00)]);
    expect(s.wonCount).toBe(2);
    expect(s.lostCount).toBe(0);
    expect(hadHeadToHead(s), "no losses on record is not a head-to-head").toBe(false);
    expect(
      wonValueRatioPct(s),
      "with no losses recorded the $ ratio is unknown, not 100%",
    ).toBeNull();
  });

  it("refuses both when nothing has been won either", () => {
    const s = summarizeWinLoss([rec({ oppId: "n1", outcome: "no_bid", valueCents: 500_00 })]);
    expect(hadHeadToHead(s)).toBe(false);
    expect(wonValueRatioPct(s)).toBeNull();
  });

  it("refuses when both sides exist but carry no value", () => {
    // Real for unpriced bids: a percentage of nothing is still not an answer,
    // and 0/0 would otherwise be NaN%.
    const s = summarizeWinLoss([won(0), lost(0)]);
    expect(hadHeadToHead(s)).toBe(true);
    expect(wonValueRatioPct(s)).toBeNull();
  });

  it("answers as soon as there is a real head-to-head", () => {
    const s = summarizeWinLoss([won(750_00), lost(250_00)]);
    expect(hadHeadToHead(s)).toBe(true);
    expect(wonValueRatioPct(s)).toBe(75);
  });

  it("is a DOLLAR ratio, not a count ratio — that is the whole point of the tile", () => {
    // One big win against three small losses: 25% by count, 80% by dollars.
    const s = summarizeWinLoss([won(400_00), lost(50_00), lost(30_00), lost(20_00)]);
    expect(s.winRatePct).toBe(25);
    expect(wonValueRatioPct(s)).toBe(80);
  });
});
