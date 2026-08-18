import { describe, it, expect } from "vitest";
import { aiaBilledCollectedFrom } from "@/lib/commercial/aia/constants";

/** The money logic that makes an AIA-billed job stop reading "$0 billed" in the
 *  deal P&L. Billed = latest issued app's Total Completed & Stored (gross, line
 *  4); collected = latest PAID app's Total Earned Less Retainage (line 6). Both
 *  are a cumulative line off ONE app, so the detail + batch paths can't drift.
 *
 *  `dueNowCents` is the AR figure and is NET of retainage — see the decision
 *  recorded on the function itself. */
describe("aiaBilledCollectedFrom", () => {
  it("no issued application → all zeros", () => {
    expect(aiaBilledCollectedFrom({ latestIssued: null, latestPaid: null })).toEqual({
      billedCents: 0,
      collectedCents: 0,
      earnedLessRetainageCents: 0,
      retainageHeldCents: 0,
      dueNowCents: 0,
    });
  });

  it("billed = latest issued app's Total Completed & Stored (gross, incl. retainage)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: {
        totalCompletedStoredCents: 20_000_00,
        totalEarnedLessRetainageCents: 19_000_00,
      },
      latestPaid: null, // submitted-but-unpaid → nothing collected
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(0);
    // The GC owes the NET now; the $1k retainage is owed at close-out.
    expect(r.dueNowCents).toBe(19_000_00);
    expect(r.retainageHeldCents).toBe(1_000_00);
  });

  it("collected = latest PAID app's Total Earned Less Retainage (net of retainage)", () => {
    // $20k completed, latest paid app earned-less-5%-retainage = $19k collected;
    // the $1k retainage stays held but is NOT currently receivable.
    const r = aiaBilledCollectedFrom({
      latestIssued: {
        totalCompletedStoredCents: 20_000_00,
        totalEarnedLessRetainageCents: 19_000_00,
      },
      latestPaid: { totalEarnedLessRetainageCents: 19_000_00 },
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(19_000_00);
    expect(r.retainageHeldCents).toBe(1_000_00);
    // THE POINT: fully paid to date reads $0 owed, not $1k overdue. Folding
    // retainage into AR would age this job past due while the GC is current.
    expect(r.dueNowCents).toBe(0);
  });

  it("latest app submitted (unpaid) but a PRIOR app paid → due now is the gap", () => {
    // App 2 just submitted ($20k completed, $19k earned); App 1 was paid ($9.5k).
    const r = aiaBilledCollectedFrom({
      latestIssued: {
        totalCompletedStoredCents: 20_000_00,
        totalEarnedLessRetainageCents: 19_000_00,
      },
      latestPaid: { totalEarnedLessRetainageCents: 9_500_00 },
    });
    expect(r.billedCents).toBe(20_000_00);
    expect(r.collectedCents).toBe(9_500_00);
    expect(r.dueNowCents).toBe(9_500_00); // 19,000 − 9,500
    expect(r.retainageHeldCents).toBe(1_000_00);
  });

  it("never reports collected > billed (data-glitch guard on the CEO dashboard)", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: {
        totalCompletedStoredCents: 5_000_00,
        totalEarnedLessRetainageCents: 4_750_00,
      },
      latestPaid: { totalEarnedLessRetainageCents: 9_000_00 },
    });
    expect(r.collectedCents).toBe(5_000_00); // clamped to billed
    expect(r.dueNowCents).toBe(0); // never negative
  });

  it("a bad import where line 6 exceeds line 4 can't invent negative retainage", () => {
    const r = aiaBilledCollectedFrom({
      latestIssued: {
        totalCompletedStoredCents: 10_000_00,
        totalEarnedLessRetainageCents: 12_000_00,
      },
      latestPaid: null,
    });
    expect(r.earnedLessRetainageCents).toBe(10_000_00); // clamped to line 4
    expect(r.retainageHeldCents).toBe(0);
    expect(r.dueNowCents).toBe(10_000_00);
  });
});
