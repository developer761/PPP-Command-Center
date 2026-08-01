import { describe, it, expect } from "vitest";
import { agingBucketKey } from "@/lib/commercial/invoices/statement";
import { splitOpenBalance } from "@/lib/commercial/invoices/rollup";

/**
 * Phase 1 audit regressions:
 *  - F8: an invoice overdue by < 1 day floors to daysPastDue 0 but must NOT be
 *        bucketed "Current" (it's already flagged overdue).
 *  - F3: a credit on one invoice must never net away another's open balance;
 *        the statement total == Σ per-invoice max(0, balance).
 */

describe("agingBucketKey — statement aging buckets (F8)", () => {
  it("not-yet-due (or no due date) is Current", () => {
    expect(agingBucketKey(null, false)).toBe("current");
    expect(agingBucketKey(-5, false)).toBe("current");
    expect(agingBucketKey(0, false)).toBe("current");
  });

  it("overdue by < 1 day (daysPastDue 0, isOverdue true) is NOT Current — it's 1–30", () => {
    expect(agingBucketKey(0, true)).toBe("d1_30");
  });

  it("day boundaries land in the inclusive bucket", () => {
    expect(agingBucketKey(1, true)).toBe("d1_30");
    expect(agingBucketKey(30, true)).toBe("d1_30");
    expect(agingBucketKey(31, true)).toBe("d31_60");
    expect(agingBucketKey(60, true)).toBe("d31_60");
    expect(agingBucketKey(61, true)).toBe("d61_90");
    expect(agingBucketKey(90, true)).toBe("d61_90");
    expect(agingBucketKey(91, true)).toBe("d90_plus");
    expect(agingBucketKey(365, true)).toBe("d90_plus");
  });
});

describe("splitOpenBalance — open receivable vs credit (F3)", () => {
  it("all unpaid: openBalance is the sum, no credit", () => {
    expect(splitOpenBalance([1000, 500])).toEqual({ openBalance: 1500, credit: 0 });
  });

  it("a credit on one invoice does NOT reduce another's open balance", () => {
    // Invoice A unpaid $1,000; Invoice B overpaid by $300 (balance -300).
    // Net would be $700, but the true open receivable is $1,000 + a $300 credit.
    expect(splitOpenBalance([1000, -300])).toEqual({ openBalance: 1000, credit: 300 });
  });

  it("credit-only account: zero open balance, credit surfaced", () => {
    expect(splitOpenBalance([-500, -200])).toEqual({ openBalance: 0, credit: 700 });
  });

  it("fully-paid invoices (balance 0) contribute nothing", () => {
    expect(splitOpenBalance([0, 0, 250])).toEqual({ openBalance: 250, credit: 0 });
  });

  it("empty set is zeroed", () => {
    expect(splitOpenBalance([])).toEqual({ openBalance: 0, credit: 0 });
  });
});
