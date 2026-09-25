import { describe, it, expect } from "vitest";
import { winRate, type AccountOverview } from "@/lib/commercial/accounts/overview";
import { hadHeadToHead, wonValueRatioPct } from "@/lib/commercial/win-loss/reports";

/**
 * A win rate needs something to have been lost.
 *
 * Four surfaces computed one, and every one of them guarded only the EMPTY
 * case — no decided bids at all. None guarded the case Tomco is actually in:
 * the migration imported 92 won jobs and zero lost bids, so "wins, no losses"
 * is not a hypothetical, it is the live database. Each surface therefore
 * printed a confident 100%:
 *
 *   the account subtitle      "100% win · ~32d close", on every GC with a job
 *   the dashboard Wins tile   "100% win", the one Alex opens every morning
 *   the competitors page      a perfect record against every rival
 *   the Win/Loss $ ratio      "100% of every $ we bid on"
 *
 * The fourth is the one that shows the shape of the mistake clearest: the
 * "win rate" tile beside it already refused, printing "— · none lost on
 * record", and the two sat side by side disagreeing off the same rows. The
 * case was understood; narrowing it in one place left the others alone.
 *
 * 100% is not what we know. It is what we have no record of losing.
 *
 * ── THE ONE DELIBERATE EXCEPTION ───────────────────────────────────────────
 *
 * The estimator report keeps 100% for 2-won-0-lost, and that is not an
 * oversight — `reports-estimator.test.ts` argues it and pins it. The
 * difference is the denominator: that report shows the decided counts beside
 * the percentage, so "100% of 2" is visible. The account subtitle shows no
 * denominator at all, which is why it cannot keep the same answer.
 *
 * Pinned on the predicates rather than the JSX, so a tile rewrite cannot
 * quietly bring it back.
 */

const overview = (won: number, lost: number): AccountOverview =>
  ({ won_opps_count: won, lost_opps_count: lost }) as AccountOverview;

describe("the account subtitle", () => {
  it("refuses a rate when nothing has been lost — Tomco's live state", () => {
    expect(
      winRate(overview(7, 0)),
      "seven wins and no recorded losses is not a 100% win rate",
    ).toBeNull();
  });

  it("refuses when nothing has been won either", () => {
    expect(winRate(overview(0, 3))).toBeNull();
    expect(winRate(overview(0, 0))).toBeNull();
  });

  it("answers as soon as there is a real head-to-head", () => {
    expect(winRate(overview(3, 1))).toBeCloseTo(0.75, 10);
    expect(winRate(overview(1, 1))).toBeCloseTo(0.5, 10);
  });

  it("survives a missing count rather than treating it as a loss", () => {
    // Both columns are nullable; `?? 0` must not turn an unknown into a zero
    // that then reads as a clean sweep.
    expect(winRate({} as AccountOverview)).toBeNull();
    expect(winRate(null)).toBeNull();
    expect(winRate(undefined)).toBeNull();
  });
});

describe("the Win/Loss report and the account page agree on the rule", () => {
  it("both refuse the same shape", () => {
    expect(hadHeadToHead({ wonCount: 7, lostCount: 0 })).toBe(false);
    expect(winRate(overview(7, 0))).toBeNull();
  });

  it("both answer the same shape", () => {
    expect(hadHeadToHead({ wonCount: 3, lostCount: 1 })).toBe(true);
    expect(winRate(overview(3, 1))).not.toBeNull();
  });

  it("the dollar ratio follows the same predicate, not its own", () => {
    expect(
      wonValueRatioPct({
        wonCount: 7,
        lostCount: 0,
        wonValueCents: 500_000_00,
        lostValueCents: 0,
      }),
    ).toBeNull();
  });
});
