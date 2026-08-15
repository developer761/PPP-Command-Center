import { describe, it, expect } from "vitest";
import { aiaBilledCollectedFrom } from "@/lib/commercial/aia/constants";

/** The money logic that makes an AIA-billed job stop reading "$0 billed" in the
 *  deal P&L. Billed = latest issued app's Total Completed & Stored (gross, line
 *  4); collected = latest PAID app's Total Earned Less Retainage (line 6). Both
 *  are a cumulative line off ONE app, so the detail + batch paths can't drift. */
describe("aiaBilledCollectedFrom", () => {
  it("no issued application → $0/$0", () => {
    expect(aiaBilledCollectedFrom({ latestIssued: null, latestPaid: null })).toEqual({
      billedCents: 0,
      collectedCents: 0,
    });
  });

  it("billed = latest issued app's Total Completed & Stored (gross, incl. retainage)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 20_000_00 },
      latestPaid: null, // submitted-but-unpaid → nothing collected
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(0);
  });

  it("collected = latest PAID app's Total Earned Less Retainage (net of retainage)", () => {
    // $20k completed, latest paid app earned-less-5%-retainage = $19k collected;
    // the $1k retainage stays outstanding.
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 20_000_00 },
      latestPaid: { totalEarnedLessRetainageCents: 19_000_00 },
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(19_000_00);
    expect(r.billedCents - r.collectedCents).toBe(1_000_00); // retainage held, outstanding
  });

  it("latest app submitted (unpaid) but a PRIOR app paid → collected = that paid app's line 6", () => {
    // App 2 just submitted ($20k completed); App 1 was paid ($9.5k earned-less-retainage).
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 20_000_00 },
      latestPaid: { totalEarnedLessRetainageCents: 9_500_00 },
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(9_500_00);
  });

  it("never reports collected > billed (data-glitch guard on the CEO dashboard)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: { totalCompletedStoredCents: 5_000_00 },
      latestPaid: { totalEarnedLessRetainageCents: 9_000_00 },
    });
    expect(r.collectedCents).toBe(5_000_00); // clamped to billed
  });
});
