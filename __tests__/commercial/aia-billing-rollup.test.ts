import { describe, it, expect } from "vitest";
import {
  aiaBilledCollectedFrom,
  computeG702,
  lineCompletedStoredCents,
} from "@/lib/commercial/aia/constants";

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

/**
 * `aiaBillingRollupBulk` (used by the AR aging report, the AR statement and the
 * account rollup) does NOT call computeG702 — it sums the line rule directly so
 * a whole book of business resolves in two queries instead of ~5 per
 * opportunity. That is only safe while the two derivations agree to the penny,
 * so this pins the arithmetic the batched path relies on.
 */
describe("bulk rollup derivation matches computeG702 to the penny", () => {
  const lines = [
    // Deliberately awkward: odd cents, a materials-stored line, and a DEDUCTIVE
    // (credit) line — the case that per-column clamping exists for.
    { scheduled_value_cents: 333_33, from_previous_cents: 111_11, this_period_cents: 55_55, materials_stored_cents: 0 },
    { scheduled_value_cents: 1_000_01, from_previous_cents: 0, this_period_cents: 250_07, materials_stored_cents: 99_99 },
    { scheduled_value_cents: -500_00, from_previous_cents: 0, this_period_cents: -125_00, materials_stored_cents: 0 },
  ];

  for (const pct of [0, 5, 10, 7.5]) {
    it(`agrees at ${pct}% retainage`, () => {
      const g702 = computeG702({
        originalContractCents: 100_000_00,
        netChangeOrdersCents: 0,
        retainagePct: pct,
        lines,
        previousCertificatesCents: 0,
      });

      // What the batched path computes from the same rows.
      const completed = lines.reduce((s, l) => s + lineCompletedStoredCents(l), 0);
      const clamped = Math.min(100, Math.max(0, pct));
      const retainage = lines.reduce(
        (s, l) => s + Math.round((lineCompletedStoredCents(l) * clamped) / 100),
        0
      );

      expect(completed).toBe(g702.totalCompletedStoredCents);
      expect(retainage).toBe(g702.retainageCents);
      expect(completed - retainage).toBe(g702.totalEarnedLessRetainageCents);

      // …and therefore the figures every AR surface renders are identical
      // whichever path produced them.
      const viaBulk = aiaBilledCollectedFrom({
        latestIssued: {
          totalCompletedStoredCents: completed,
          totalEarnedLessRetainageCents: completed - retainage,
        },
        latestPaid: null,
      });
      const viaG702 = aiaBilledCollectedFrom({ latestIssued: g702, latestPaid: null });
      expect(viaBulk).toEqual(viaG702);
    });
  }
});
