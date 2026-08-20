import { describe, it, expect } from "vitest";
import {
  summarizeChangeOrderRegister,
  type ChangeOrderRegisterRow,
} from "@/lib/commercial/change-orders/register-pdf";

/**
 * The Change Orders register — Brendan's format, sent to a GC.
 *
 * Its summary prints "Total Change Orders" directly above "Updated Contract
 * Total", and those two DO NOT MATCH on most real jobs: the first is the
 * register's own total (every CO ever raised, which is what makes it reconcile
 * with the cards above it), the second moves only on approval.
 *
 * So the reconciling sentence is the whole point of the block, and it is what
 * these cases are about. It originally named only the pending money, which
 * left a job with a rejected CO and nothing pending printing an unexplained
 * discrepancy to a GC's AP department.
 */

const money = (c: number) => `$${(c / 100).toLocaleString("en-US")}`;

const row = (
  status: ChangeOrderRegisterRow["status"],
  amountCents: number,
  n = 1
): ChangeOrderRegisterRow =>
  ({ coNumber: n, title: `CO ${n}`, description: null, amountCents, status, dateIso: null }) as ChangeOrderRegisterRow;

const ORIGINAL = 200_000_00;

describe("summarizeChangeOrderRegister", () => {
  it("moves the contract on approved money only", () => {
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("pending", 25_000_00, 2), row("declined", 40_000_00, 3)],
      ORIGINAL,
      money
    );
    expect(s.approvedTotal).toBe(10_000_00);
    expect(s.updatedContract).toBe(210_000_00);
    // …while the register's own total is every CO raised.
    expect(s.allTotal).toBe(75_000_00);
  });

  it("says nothing when the two totals already agree", () => {
    const s = summarizeChangeOrderRegister([row("approved", 10_000_00)], ORIGINAL, money);
    expect(s.note).toBeNull();
  });

  it("explains pending money", () => {
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("pending", 25_000_00, 2)],
      ORIGINAL,
      money
    );
    expect(s.note).toContain("APPROVED change orders only");
    expect(s.note).toContain("$25,000 pending");
    expect(s.note).not.toContain("rejected");
  });

  // The bug. Pending was named; rejected was not — so this job printed
  // "Total Change Orders $50,000" above a $10,000 contract increase with
  // nothing on the page accounting for the other $40,000.
  it("explains REJECTED money even when nothing is pending", () => {
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("declined", 40_000_00, 2)],
      ORIGINAL,
      money
    );
    expect(s.note).not.toBeNull();
    expect(s.note).toContain("$40,000 rejected");
    expect(s.note).not.toContain("pending");
  });

  it("explains both when both are present", () => {
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("pending", 25_000_00, 2), row("declined", 40_000_00, 3)],
      ORIGINAL,
      money
    );
    expect(s.note).toContain("$25,000 pending");
    expect(s.note).toContain("$40,000 rejected");
  });

  it("a deduct CO reduces the contract rather than inflating it", () => {
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("approved", -3_000_00, 2)],
      ORIGINAL,
      money
    );
    expect(s.approvedTotal).toBe(7_000_00);
    expect(s.updatedContract).toBe(207_000_00);
  });

  it("says nothing about a contract it doesn't have", () => {
    // No bid on file → no "Updated Contract Total" is printed, so a note
    // reconciling to it would point at a line that isn't there.
    const s = summarizeChangeOrderRegister(
      [row("approved", 10_000_00, 1), row("declined", 40_000_00, 2)],
      null,
      money
    );
    expect(s.updatedContract).toBeNull();
    expect(s.note).toBeNull();
  });

  it("handles an empty register", () => {
    const s = summarizeChangeOrderRegister([], ORIGINAL, money);
    expect(s.allTotal).toBe(0);
    expect(s.updatedContract).toBe(ORIGINAL);
    expect(s.note).toBeNull();
  });
});
