import { describe, it, expect } from "vitest";

import { formatBidCents } from "@/lib/commercial/accounts/overview";
import { formatBidRange } from "@/lib/commercial/opportunities/db";

/**
 * A "range" between a number and itself is not a range.
 *
 * Karan 2026-09-17: "BID RANGE (OPEN) $2.1M–$2.1M … that Bid range is confusing
 * for everyone, we need to fix that."
 *
 * Not a rounding artefact. Of the 38 open pre-sale opportunities in the book,
 * 34 carry a value and EVERY ONE has `bid_value_low_cents ===
 * bid_value_high_cents` — nobody at Tomco enters a spread, they enter the
 * number they bid. So the card printed one figure twice with a dash through it,
 * on every deal, permanently.
 *
 * Both shared formatters already collapsed the equal case correctly. The defect
 * was two screens that hand-rolled `${fmt(low)}–${fmt(high)}` instead of
 * calling them — the opportunities KPI strip and the account scorecard. That is
 * the failure mode worth pinning: not a broken helper, a bypassed one.
 */

describe("formatBidCents", () => {
  it("prints ONE number when low and high are the same", () => {
    // THE BUG, in the shape it reached the screen.
    const s = formatBidCents(211_269_279, 211_269_279);
    expect(s).not.toContain("–");
    expect(s).not.toContain("-");
    expect(s).toBe(formatBidCents(211_269_279, 211_269_279));
  });

  it("still prints a range when there genuinely is one", () => {
    // The feature is not removed — it just stops firing on a non-range.
    expect(formatBidCents(5_000_00, 7_500_00)).toContain("–");
  });

  it("handles a one-sided bid", () => {
    expect(formatBidCents(null, 7_500_00)).toMatch(/^≤ /);
    expect(formatBidCents(5_000_00, null)).toMatch(/\+$/);
  });

  it("says nothing rather than zero when nothing is priced", () => {
    expect(formatBidCents(null, null)).toBe("—");
  });
});

describe("formatBidRange", () => {
  it("agrees with formatBidCents on the equal case", () => {
    // Two formatters for one concept is how the account page and the deal
    // header came to disagree about the same bid once before.
    const s = formatBidRange(142_000_00, 142_000_00);
    expect(s).not.toContain("–");
    expect(formatBidRange(50_000_00, 75_000_00)).toContain("–");
  });

  it("does not invent a bid that is not there", () => {
    expect(formatBidRange(null, null)).toBe("—");
  });
});
