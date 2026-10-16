import { describe, it, expect } from "vitest";
import {
  computeG702,
  applyReleasedRetainage,
  aiaLineIdentityKey,
  lineRetainageCents,
  lineRetainableCompletedCents,
  type AiaLineInput,
} from "@/lib/commercial/aia/constants";

/**
 * STEPHANIE, 2026-10-16, on the LMJ Cipla expansion — the job she calls "a
 * billing nightmare":
 *
 *   "We billed the contract in full and then billed for retainage and then
 *    received payment on the job in full. After we received that payment, a
 *    change order came across and we had to bill for that plus retainage. This
 *    happened 2x... I am trying to record it in Command and it is pulling
 *    details from the paid retainage AIA and giving me negative numbers. When
 *    this happens, the retainage, balance to finish, and current payment due
 *    should zero out leaving the balance to finish, payment due, and the
 *    retainage to just be for the change order, ex: $1000 CO, 5% ret, $950 due
 *    and $50 ret, $50 balance to finish."
 *
 * Her $1,000 example is the first test below, to the penny. The second is her
 * REAL numbers, read off the live rows on 2026-10-16 — Application 6 was
 * showing line 8 as MINUS $3,431.36.
 *
 * This is customer-facing money on a document a general contractor's accounts
 * payable department processes, so every line is pinned.
 */

const line = (
  item: string,
  scheduled: number,
  fromPrev: number,
  thisPeriod: number,
  stored = 0
): AiaLineInput & { description: string } => ({
  item_no: item,
  description: `Line ${item}`,
  scheduled_value_cents: scheduled,
  from_previous_cents: fromPrev,
  this_period_cents: thisPeriod,
  materials_stored_cents: stored,
});

describe("retainage is withheld once — a release is not re-retained", () => {
  it("Stephanie's worked example: $1,000 CO after a release → $50 held, $950 due, $50 to finish", () => {
    // The release application: the whole $100,000 contract, retainage 0%.
    const release = [line("1", 100_000_00, 100_000_00, 0)];
    // The next application: same scope carried forward, plus a $1,000 change
    // order billed in full this period. Back to the contract's 5%.
    const next = applyReleasedRetainage(
      [line("1", 100_000_00, 100_000_00, 0), line("CO-001", 1_000_00, 0, 1_000_00)],
      release
    );

    const g = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      lines: next,
      // Line 7 is the release's line 6 — the whole contract, nothing held.
      previousCertificatesCents: 100_000_00,
    });

    expect(g.totalCompletedStoredCents).toBe(101_000_00);
    expect(g.retainageCents).toBe(50_00); // 5% of the change order ONLY
    expect(g.totalEarnedLessRetainageCents).toBe(100_950_00);
    expect(g.currentPaymentDueCents).toBe(950_00); // what the GC pays
    expect(g.balanceToFinishCents).toBe(50_00); // the retainage still held
  });

  it("without the release baseline the same sheet pays MINUS $4,050 — the bug", () => {
    const g = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      // The SAME lines, un-stamped: nothing tells the math what was released.
      lines: [line("1", 100_000_00, 100_000_00, 0), line("CO-001", 1_000_00, 0, 1_000_00)],
      previousCertificatesCents: 100_000_00,
    });
    expect(g.retainageCents).toBe(5_050_00);
    expect(g.currentPaymentDueCents).toBe(-4_050_00);
  });

  it("LMJ Cipla Application 6, the live row: line 8 goes from -$3,431.36 to $950.00", () => {
    // Measured 2026-10-16. App 5 was the retainage release: $87,627.09
    // completed at 0%, so line 6 (and therefore App 6's line 7) is the lot.
    const release = [line("1", 87_627_09, 87_627_09, 0)];
    const lines = applyReleasedRetainage(
      [line("1", 87_627_09, 87_627_09, 0), line("CO-003", 1_000_00, 0, 1_000_00)],
      release
    );
    const g = computeG702({
      originalContractCents: 87_627_09,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 87_627_09,
    });
    expect(g.retainageCents).toBe(50_00);
    expect(g.currentPaymentDueCents).toBe(950_00);
    expect(g.balanceToFinishCents).toBe(50_00);
  });

  it("a SECOND change order after a SECOND release is retained again, not forgiven", () => {
    // Release #2 covered everything through the first change order.
    const release2 = [line("1", 87_627_09, 87_627_09, 0), line("CO-003", 1_000_00, 1_000_00, 0)];
    const lines = applyReleasedRetainage(
      [
        line("1", 87_627_09, 87_627_09, 0),
        line("CO-003", 1_000_00, 1_000_00, 0),
        line("CO-004", 2_000_00, 0, 2_000_00),
      ],
      release2
    );
    const g = computeG702({
      originalContractCents: 87_627_09,
      netChangeOrdersCents: 3_000_00,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 88_627_09,
    });
    expect(g.retainageCents).toBe(100_00); // 5% of the NEW $2,000 only
    expect(g.currentPaymentDueCents).toBe(1_900_00);
  });

  it("work done on a released line AFTER the release is retained again", () => {
    // The release went out at 90% — close-out retainage released early. The
    // last 10% is new work and carries its own retainage.
    const release = [line("1", 100_000_00, 90_000_00, 0)];
    const lines = applyReleasedRetainage([line("1", 100_000_00, 90_000_00, 10_000_00)], release);
    expect(lines[0].retainage_released_cents).toBe(90_000_00);
    expect(lineRetainageCents(lines[0], 5)).toBe(500_00); // 5% of $10,000
  });

  it("changes NOTHING when no release has gone out", () => {
    const plain = [line("1", 100_000_00, 60_000_00, 10_000_00)];
    expect(applyReleasedRetainage(plain, null)).toBe(plain);
    expect(applyReleasedRetainage(plain, [])).toBe(plain);
    const g = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: plain,
      previousCertificatesCents: 0,
    });
    expect(g.retainageCents).toBe(3_500_00); // 5% of $70,000, exactly as before
  });

  it("a credit line still earns its retainage downward after a release", () => {
    const release = [line("1", 100_000_00, 100_000_00, 0)];
    const lines = applyReleasedRetainage(
      [line("1", 100_000_00, 100_000_00, 0), line("CO-002", -4_000_00, 0, -4_000_00)],
      release
    );
    // The deduct is not on the release sheet, so it is retained — negatively.
    expect(lineRetainageCents(lines[1], 5)).toBe(-200_00);
  });

  it("never lets a stale baseline push a line past zero", () => {
    // The release claims MORE completed than this application reports (a line
    // edited down afterwards). Retainage floors at zero; it never goes negative
    // on a positive line.
    const release = [line("1", 100_000_00, 100_000_00, 0)];
    const lines = applyReleasedRetainage([line("1", 100_000_00, 40_000_00, 0)], release);
    expect(lineRetainageCents(lines[0], 5)).toBe(0);
    expect(lineRetainableCompletedCents(lines[0])).toBe(0);
  });

  it("two lines sharing an identity split the released amount, they do not each claim it", () => {
    const release = [line("1", 100_000_00, 60_000_00, 0)];
    const lines = applyReleasedRetainage(
      [line("1", 50_000_00, 40_000_00, 0), line("1", 50_000_00, 40_000_00, 0)],
      release
    );
    expect(lines[0].retainage_released_cents).toBe(40_000_00);
    expect(lines[1].retainage_released_cents).toBe(20_000_00);
  });

  it("the 5a/5b split comes off the same base as line 5, so 5b can't go negative", () => {
    const release = [line("1", 100_000_00, 100_000_00, 0)];
    const lines = applyReleasedRetainage(
      [line("1", 100_000_00, 100_000_00, 0), line("CO-001", 1_000_00, 0, 0, 1_000_00)],
      release
    );
    const g = computeG702({
      originalContractCents: 100_000_00,
      netChangeOrdersCents: 1_000_00,
      retainagePct: 5,
      lines,
      previousCertificatesCents: 100_000_00,
    });
    // This is what lib/commercial/aia/export.ts writes into D30 and D32.
    const completedDE = lines.reduce((n, l) => n + lineRetainableCompletedCents(l), 0);
    const ret5a = Math.round((completedDE * 5) / 100);
    expect(ret5a).toBe(0); // all completed work was released; this CO is stored
    expect(g.retainageCents - ret5a).toBe(50_00); // 5b, and it foots
    // (A `toBeGreaterThanOrEqual(0)` stood here too and could never fail —
    //  the line above already pins the identical expression to 50_00.)
  });
});

describe("aiaLineIdentityKey", () => {
  it("prefers the change-order foreign key, which the operator cannot rename", () => {
    expect(aiaLineIdentityKey({ change_order_id: "abc", item_no: "CO-001", description: "x" })).toBe("co:abc");
  });
  it("falls back to item_no, then description, then position", () => {
    expect(aiaLineIdentityKey({ item_no: " CO-001 ", description: "x" })).toBe("no:co-001");
    expect(aiaLineIdentityKey({ item_no: "  ", description: " Painting " })).toBe("d:painting");
    expect(aiaLineIdentityKey({ position: 3000 })).toBe("p:3000");
  });
  it("ties a carried-forward line to its earlier self — the seed copies these verbatim", () => {
    // seedAiaScheduleOfValues copies item_no, description and change_order_id
    // and re-numbers `position`, so position alone would not match.
    const prior = { item_no: "1", description: "Base scope", position: 1000 };
    const carried = { item_no: "1", description: "Base scope", position: 2000 };
    expect(aiaLineIdentityKey(carried)).toBe(aiaLineIdentityKey(prior));
  });
});
