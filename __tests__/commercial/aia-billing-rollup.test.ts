import { describe, it, expect } from "vitest";
import { aiaBilledCollectedFrom } from "@/lib/commercial/aia/constants";

/** The money logic that makes an AIA-billed job stop reading "$0 billed" in the
 *  deal P&L. Billed = latest issued app's Total Completed & Stored (gross, line
 *  4); collected = Σ paid apps' Current Payment Due (line 8, net of retainage). */
describe("aiaBilledCollectedFrom", () => {
  it("no issued applications → $0/$0", () => {
    expect(aiaBilledCollectedFrom({ latestIssued: null, paid: [] })).toEqual({
      billedCents: 0,
      collectedCents: 0,
    });
  });

  it("billed = latest issued app's Total Completed & Stored (gross, incl. retainage)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 20_000_00 },
      paid: [],
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(0); // submitted-but-unpaid → nothing collected
  });

  it("collected = Σ paid apps' Current Payment Due (net of retainage)", () => {
    // App 1 paid $9,500 (net of 5% retainage on $10k), App 2 paid $9,500 → $19,000
    // collected against $20,000 billed; the $1,000 retainage stays outstanding.
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 20_000_00 },
      paid: [{ currentPaymentDueCents: 9_500_00 }, { currentPaymentDueCents: 9_500_00 }],
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(19_000_00);
    // Outstanding (billed − collected) = $1,000 retainage still held.
    expect(r.billedCents - r.collectedCents).toBe(1_000_00);
  });

  it("never reports collected > billed (data-glitch guard on the CEO dashboard)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 5_000_00 },
      paid: [{ currentPaymentDueCents: 9_000_00 }],
    });
    expect(r.collectedCents).toBe(5_000_00); // clamped to billed
  });

  it("ignores a negative current-payment-due row rather than crediting it", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 10_000_00 },
      paid: [{ currentPaymentDueCents: 6_000_00 }, { currentPaymentDueCents: -100_00 }],
    });
    expect(r.collectedCents).toBe(6_000_00);
  });
});
