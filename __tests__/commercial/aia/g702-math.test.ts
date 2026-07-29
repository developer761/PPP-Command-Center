import { describe, it, expect } from "vitest";
import { computeG702, lineCompletedStoredCents, pickContractBaseCents } from "@/lib/commercial/aia/constants";

/**
 * The ONE contract-base ladder shared by Projects / Account 360 / AIA G702 /
 * Change Orders. If this drifts, those four surfaces show different contract
 * totals for the same deal.
 */
describe("pickContractBaseCents", () => {
  it("uses the bid midpoint before any AIA app exists", () => {
    expect(pickContractBaseCents({ hasBillingApp: false, originalContractCents: 0, sovTotalCents: 999, bidMidCents: 10_000_00 })).toBe(10_000_00);
  });
  it("prefers the app's explicit snapshotted contract once billing exists", () => {
    expect(pickContractBaseCents({ hasBillingApp: true, originalContractCents: 11_000_00, sovTotalCents: 9_500_00, bidMidCents: 10_000_00 })).toBe(11_000_00);
  });
  it("falls back to the schedule-of-values total when no explicit contract was set", () => {
    expect(pickContractBaseCents({ hasBillingApp: true, originalContractCents: 0, sovTotalCents: 9_500_00, bidMidCents: 10_000_00 })).toBe(9_500_00);
  });
  it("does NOT fall back to the bid midpoint once an app exists (ties to the AIA doc)", () => {
    // empty draft app, no SOV, but a stray bid — contract is 0, not the bid.
    expect(pickContractBaseCents({ hasBillingApp: true, originalContractCents: 0, sovTotalCents: 0, bidMidCents: 10_000_00 })).toBe(0);
  });
});

/**
 * G702 certificate math (Phase H). This is customer-facing money, so every
 * line of the AIA summary is pinned. All amounts are cents.
 */
describe("computeG702", () => {
  const line = (
    scheduled: number,
    fromPrev: number,
    thisPeriod: number,
    stored = 0
  ) => ({
    scheduled_value_cents: scheduled,
    from_previous_cents: fromPrev,
    this_period_cents: thisPeriod,
    materials_stored_cents: stored,
  });

  it("computes a first application with retainage, no COs, no prior certs", () => {
    // $100,000 contract, 5% retainage, $40k completed this period.
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: [line(10_000_000, 0, 4_000_000)],
      previousCertificatesCents: 0,
    });
    expect(g.contractSumToDateCents).toBe(10_000_000); // 1+2
    expect(g.totalCompletedStoredCents).toBe(4_000_000); // 4
    expect(g.retainageCents).toBe(200_000); // 5% of 4M
    expect(g.totalEarnedLessRetainageCents).toBe(3_800_000); // 6
    expect(g.currentPaymentDueCents).toBe(3_800_000); // 8 (no prior)
    expect(g.balanceToFinishCents).toBe(6_200_000); // 3 - 6
    expect(g.percentCompleteBps).toBe(4000); // 40.00%
  });

  it("folds approved change orders into the contract sum to date", () => {
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 1_500_000, // +$15k approved COs
      retainagePct: 5,
      lines: [line(11_500_000, 0, 0)],
      previousCertificatesCents: 0,
    });
    expect(g.contractSumToDateCents).toBe(11_500_000);
    expect(g.balanceToFinishCents).toBe(11_500_000); // nothing earned yet
    expect(g.percentCompleteBps).toBe(0);
  });

  it("handles a deduct (negative net change order)", () => {
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: -500_000, // −$5k deduct
      retainagePct: 5,
      lines: [line(9_500_000, 0, 0)],
      previousCertificatesCents: 0,
    });
    expect(g.contractSumToDateCents).toBe(9_500_000);
  });

  it("subtracts previous certificates to give the current period's payment", () => {
    // Period 2: cumulative $60k completed, prior cert (line 6) was $38k.
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: [line(10_000_000, 4_000_000, 2_000_000)], // D 40k + E 20k = 60k
      previousCertificatesCents: 3_800_000,
    });
    expect(g.totalCompletedStoredCents).toBe(6_000_000);
    expect(g.retainageCents).toBe(300_000);
    expect(g.totalEarnedLessRetainageCents).toBe(5_700_000); // 6
    expect(g.currentPaymentDueCents).toBe(1_900_000); // 5.7M − 3.8M prior
    expect(g.balanceToFinishCents).toBe(4_300_000);
  });

  it("counts materials stored in completed & stored", () => {
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 0,
      lines: [line(10_000_000, 0, 1_000_000, 500_000)], // E 10k + F stored 5k
      previousCertificatesCents: 0,
    });
    expect(g.totalCompletedStoredCents).toBe(1_500_000);
    expect(g.retainageCents).toBe(0);
    expect(g.totalEarnedLessRetainageCents).toBe(1_500_000);
  });

  it("sums multiple G703 lines", () => {
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 10,
      lines: [line(6_000_000, 0, 3_000_000), line(4_000_000, 0, 1_000_000)],
      previousCertificatesCents: 0,
    });
    expect(g.totalCompletedStoredCents).toBe(4_000_000);
    expect(g.retainageCents).toBe(400_000); // 10%
    expect(g.totalEarnedLessRetainageCents).toBe(3_600_000);
  });

  it("returns null percent when the contract sum is zero", () => {
    const g = computeG702({
      originalContractCents: 0,
      netChangeOrdersCents: 0,
      retainagePct: 5,
      lines: [],
      previousCertificatesCents: 0,
    });
    expect(g.contractSumToDateCents).toBe(0);
    expect(g.percentCompleteBps).toBeNull();
    expect(g.currentPaymentDueCents).toBe(0);
  });

  it("clamps retainage percent to [0,100] and rounds retainage per the total", () => {
    const g = computeG702({
      originalContractCents: 10_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 150, // clamped to 100
      lines: [line(10_000_000, 0, 3_333_333)],
      previousCertificatesCents: 0,
    });
    expect(g.retainageCents).toBe(3_333_333); // 100% of the completed
    expect(g.totalEarnedLessRetainageCents).toBe(0);
  });

  it("retainage sums PER-LINE rounded (ties to the G703 sheet), not round-of-total", () => {
    // 3 lines each completed $1,000.05 @ 10%. Per-line round(10000.5)=10001 → 30003.
    // Round-of-total would give round(30001.5)=30002 — a penny mismatch a GC rejects.
    const g = computeG702({
      originalContractCents: 1_000_000,
      netChangeOrdersCents: 0,
      retainagePct: 10,
      lines: [line(200_010, 0, 100_005), line(200_010, 0, 100_005), line(200_010, 0, 100_005)],
      previousCertificatesCents: 0,
    });
    expect(g.totalCompletedStoredCents).toBe(300_015);
    expect(g.retainageCents).toBe(30_003); // Σ per-line, not round-of-total (30_002)
  });

  it("lineCompletedStoredCents floors negatives and rounds", () => {
    expect(
      lineCompletedStoredCents({
        scheduled_value_cents: 0,
        from_previous_cents: -100,
        this_period_cents: 250,
        materials_stored_cents: 50,
      })
    ).toBe(300); // negative floored to 0
  });
});
