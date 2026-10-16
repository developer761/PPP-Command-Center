import { describe, it, expect } from "vitest";
import {
  changeOrderContractLadder,
  type ChangeOrderLadderRow,
} from "@/lib/commercial/change-orders/pdf-data";

/**
 * EVERY CHANGE ORDER PRINTS **ITS OWN** REVISED CONTRACT SUM.
 *
 * The figure under "Revised contract sum" is what a GC signs against, and
 * until 2026-10-16 it was the deal's contract sum TODAY — `base + net of ALL
 * approved change orders`, with this one backed out to get "prior". That is
 * the same number on every change order of a deal, whatever its position or
 * its amount.
 *
 * Live, measured through `buildChangeOrderPdfInput` against the real database:
 *
 *   LMJ Cipla      CO-002 +$1,200   printed $100,127.09   should be $70,200.00
 *   LMJ Cipla      CO-003 +$2,500   printed $100,127.09   should be $72,700.00
 *   VCA West Islip CO-001 +$2,250   printed  $68,375.00   should be $48,000.00
 *
 * $29,927.09 overstated on the first of those, on a signed amendment.
 *
 * The first attempt at a test here asserted the source no longer mentions
 * `netApprovedChangeOrderCents`. That is worthless — it passes on a file that
 * computes the wrong number a different way. So this calls the function and
 * checks the arithmetic, and the ladder is an exported pure function
 * specifically so it can be called.
 */

const co = (
  co_number: number,
  amount_cents: number,
  status: ChangeOrderLadderRow["status"] = "approved"
): ChangeOrderLadderRow => ({ co_number, amount_cents, status });

const ladder = (baseCents: number, subject: ChangeOrderLadderRow, siblings: ChangeOrderLadderRow[]) =>
  changeOrderContractLadder({ baseCents, co: subject, siblings });

describe("the LMJ Cipla stack — seven approvals, one morning", () => {
  // The real numbers. co_number starts at 002: CO-001 was deleted, which is
  // also why "count them off" and "read the co_number" are different sums.
  const BASE = 69_000_00;
  const stack = [
    co(2, 1_200_00), co(3, 2_500_00), co(4, 2_718_75), co(5, 8_208_34),
    co(6, 4_000_00), co(7, 1_000_00), co(8, 11_500_00),
  ];

  it("CO-002 reads $69,000.00 → $70,200.00, not the deal's $100,127.09", () => {
    expect(ladder(BASE, stack[0], stack)).toEqual({
      priorContractCents: 69_000_00,
      revisedContractCents: 70_200_00,
    });
  });

  it("each one's REVISED is the next one's PRIOR — the chain a GC reads across", () => {
    // This is the invariant the old code broke in the most visible way: seven
    // documents, seven identical totals, no chain at all.
    for (let i = 1; i < stack.length; i++) {
      const before = ladder(BASE, stack[i - 1], stack);
      const here = ladder(BASE, stack[i], stack);
      expect(here.priorContractCents, `CO-00${stack[i].co_number} prior`).toBe(
        before.revisedContractCents
      );
    }
  });

  it("the LAST one still lands on the deal's real contract sum", () => {
    // The old behaviour was not wrong about the DESTINATION — only about every
    // rung before it. The fix must not move the end of the chain.
    const net = stack.reduce((n, c) => n + c.amount_cents, 0);
    expect(ladder(BASE, stack[stack.length - 1], stack).revisedContractCents).toBe(BASE + net);
  });

  it("does not care what order the siblings arrive in", () => {
    const shuffled = [...stack].reverse();
    expect(ladder(BASE, stack[3], shuffled)).toEqual(ladder(BASE, stack[3], stack));
  });
});

describe("what counts as a rung", () => {
  const BASE = 100_000_00;

  it("a PENDING sibling is not in the ladder — nobody has agreed to it", () => {
    const subject = co(3, 5_000_00);
    const siblings = [co(1, 1_000_00), co(2, 9_999_00, "pending"), subject];
    expect(ladder(BASE, subject, siblings)).toEqual({
      priorContractCents: 101_000_00,
      revisedContractCents: 106_000_00,
    });
  });

  it("a DECLINED sibling is not in the ladder either", () => {
    const subject = co(3, 5_000_00);
    const siblings = [co(1, 1_000_00), co(2, 9_999_00, "declined"), subject];
    expect(ladder(BASE, subject, siblings).priorContractCents).toBe(101_000_00);
  });

  it("a LATER approved sibling is not in THIS one's prior", () => {
    // Water Lilies' shape: CO-001 approved, CO-002/3/4 still out. Reading the
    // deal's net would have put CO-004's $42,000 inside CO-002's prior sum.
    const subject = co(1, 21_775_00);
    const siblings = [subject, co(2, 23_050_00), co(3, 11_570_00), co(4, 42_000_00)];
    expect(ladder(99_800_00, subject, siblings)).toEqual({
      priorContractCents: 99_800_00,
      revisedContractCents: 121_575_00,
    });
  });

  it("a PENDING subject still prints its own proposal — 'approve this and it becomes X'", () => {
    const subject = co(2, 23_050_00, "pending");
    const siblings = [co(1, 21_775_00), subject];
    expect(ladder(99_800_00, subject, siblings)).toEqual({
      priorContractCents: 121_575_00,
      revisedContractCents: 144_625_00,
    });
  });

  it("a DECLINED subject prints no adjustment at all", () => {
    const subject = co(2, 3_950_00, "declined");
    expect(ladder(15_450_00, subject, [co(1, 10_300_00), subject])).toEqual({
      priorContractCents: null,
      revisedContractCents: null,
    });
  });

  it("no known contract base → no adjustment block, not an adjustment off $0", () => {
    const subject = co(1, 5_000_00);
    expect(ladder(0, subject, [subject])).toEqual({
      priorContractCents: null,
      revisedContractCents: null,
    });
  });
});

describe("the cases the ordering had to survive", () => {
  it("two change orders decided the SAME DAY still chain by number", () => {
    // Seven of LMJ Cipla's were decided inside twenty minutes of one morning,
    // two of them 45 seconds apart. `decided_at` is not consulted at all —
    // which is the point: there is no timestamp to tie on.
    const a = co(1, 2_250_00);
    const b = co(2, 20_375_00);
    expect(ladder(45_750_00, a, [a, b])).toEqual({
      priorContractCents: 45_750_00, revisedContractCents: 48_000_00,
    });
    expect(ladder(45_750_00, b, [a, b])).toEqual({
      priorContractCents: 48_000_00, revisedContractCents: 68_375_00,
    });
  });

  it("an approval with a NULL decided_at is an ordinary rung", () => {
    // Older approvals carry no decision date. Under a decided_at ordering they
    // would have to be guessed at or dropped; under co_number they are simply
    // rungs. The row type does not even carry the column.
    const subject = co(2, 550_00);
    expect(ladder(37_000_00, subject, [co(1, 18_250_00), subject])).toEqual({
      priorContractCents: 55_250_00, revisedContractCents: 55_800_00,
    });
  });

  it("a DEDUCT lowers the revised sum and every rung after it", () => {
    const credit = co(2, -2_000_00);
    const after = co(3, 1_500_00);
    const siblings = [co(1, 1_000_00), credit, after];
    expect(ladder(10_000_00, credit, siblings)).toEqual({
      priorContractCents: 11_000_00, revisedContractCents: 9_000_00,
    });
    expect(ladder(10_000_00, after, siblings)).toEqual({
      priorContractCents: 9_000_00, revisedContractCents: 10_500_00,
    });
  });

  it("a deduct that cancels the whole contract reads $0.00 — and that is honest", () => {
    // MS Packaging Ceiling Repair: a $2,000 contract with an approved -$2,000
    // change order prints "Revised contract sum $0.00". It looked like part of
    // this bug and is not: a single change order has no ladder to get wrong.
    // The $0.00 is what the two stored numbers say, and if it is wrong the
    // amount is wrong, not the arithmetic.
    const subject = co(1, -2_000_00);
    expect(ladder(2_000_00, subject, [subject])).toEqual({
      priorContractCents: 2_000_00, revisedContractCents: 0,
    });
  });
});
