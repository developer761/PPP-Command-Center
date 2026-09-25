import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bidMidCents } from "@/lib/commercial/reports/pipeline";

/**
 * The two halves of the Pipeline page value a bid the same way.
 *
 * That page renders a table and, above it, a set of tiles plus a per-stage
 * breakdown — from two independent functions. On 2026-09-25 they reported the
 * same forty open bids as $2,112,692.79 and $2,167,229.99, a $54,537.20 gap on
 * one screen with nothing to say which was right.
 *
 * Neither number was rounding. The table totalled `bid_value_low_cents ?? 0` —
 * one end of a range, and ZERO where there is no range — while the tiles used
 * `bidMidCents`, which falls back to the current proposal. The gap was exactly
 * two opportunities with no bid range and a priced proposal on file:
 *
 *   Vision General Contractors · Tesla CC, Islip   proposal SENT   $38,030.20
 *   LMJ … TEST COMPANY · 123 Main St               draft           $16,507.00
 *
 * The first is a real quote sitting with a real GC, and the pipeline total
 * Brendan reads valued it at nothing. A report that is merely imprecise gets
 * questioned; one that silently drops a live deal to zero does not.
 *
 * Both halves now call `bidMidCents`. These pin the behaviour that makes that
 * safe — above all that the proposal fallback is used, since dropping it is
 * what reintroduces the bug.
 */

const opp = (low: number | null, high: number | null) =>
  ({ bid_value_low_cents: low, bid_value_high_cents: high }) as Parameters<typeof bidMidCents>[0];

describe("bidMidCents", () => {
  it("falls back to the proposal when there is no range at all", () => {
    // The Vision General Contractors case, to the cent.
    expect(bidMidCents(opp(null, null), 38_030_20)).toBe(38_030_20);
  });

  it("is zero only when there is no range AND no proposal", () => {
    expect(bidMidCents(opp(null, null), null)).toBe(0);
    expect(bidMidCents(opp(null, null), undefined)).toBe(0);
    expect(bidMidCents(opp(null, null))).toBe(0);
  });

  it("takes the midpoint of a real range", () => {
    expect(bidMidCents(opp(100_00, 300_00), null)).toBe(200_00);
  });

  it("rounds the midpoint to a whole cent rather than emitting a fraction", () => {
    // An odd sum would otherwise put a half-cent into a money total.
    expect(bidMidCents(opp(100_01, 100_02), null)).toBe(100_02);
    expect(Number.isInteger(bidMidCents(opp(1, 2), null))).toBe(true);
  });

  it("uses whichever end exists when only one does", () => {
    expect(bidMidCents(opp(250_00, null), null)).toBe(250_00);
    expect(bidMidCents(opp(null, 250_00), null)).toBe(250_00);
  });

  it("prefers the range over the proposal when both exist", () => {
    // The range is what somebody typed for THIS bid; the proposal is the
    // fallback for when they typed nothing.
    expect(bidMidCents(opp(100_00, 100_00), 999_00)).toBe(100_00);
  });

  it("treats a zero range as a real answer, not a missing one", () => {
    // `?? 0` vs `=== null` is the distinction the old code got wrong in the
    // other direction. An explicit 0 bid is a decision; null is an absence.
    expect(bidMidCents(opp(0, 0), 500_00)).toBe(0);
  });
});

/**
 * Asserted on the SOURCE because the two totals come from different modules
 * and reconciling them for real needs a database. This is the cheap half of
 * the seam: if the deal-report rows ever go back to reading a raw range
 * column, this goes red and names the page it breaks.
 */
describe("the deal-report rows use the shared derivation", () => {
  const src = readFileSync("lib/commercial/reports/tomco/opportunities.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("calls bidMidCents", () => {
    expect(src).toContain("bidMidCents(o, proposalTotalByOpp.get(o.id))");
  });

  it("no longer totals a bare range column", () => {
    expect(
      /bid\s*=\s*Number\(o\.bid_value_low_cents/.test(src),
      "reading bid_value_low_cents raw is what made the table disagree with the tiles above it",
    ).toBe(false);
  });
});
