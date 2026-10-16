import { describe, it, expect } from "vitest";
import { dealMargin, marginFrom, unratedCoverageFrom } from "@/lib/commercial/projects/financials";
import {
  unratedHoursNote,
  unratedHoursShort,
  noPayoutCoverage,
} from "@/lib/commercial/field-ops/unrated-hours-note";
import { renderDigestEmail, type DigestData } from "@/lib/commercial/reports/alex-digest";

/**
 * "MARGIN READS HIGH" WAS WRONG ON 79 OF 81 DEALS, AND NAMED THE HARMFUL FIX.
 *
 * `dealMargin` attached the caveat whenever `laborUnratedHours > 0`, with no
 * check that the labor had been paid some other way. Measured against
 * production 2026-10-16: 14,637 hours read unrated across 81 deals, and 14,589
 * of them — on 79 of the 81 — already carried `labor`/`employee_labor`
 * purchases naming the same nine people ($604,948.35 across those deals).
 *
 *   LMJ Cipla   1,063 unrated hours, $36,456.22 of labor booked for exactly
 *               those people, and the deal page read "Margin reads high —
 *               1063 of the crew hours on this job are not costed yet."
 *   Greg          250 unrated hours against $12,295.01 booked — $49.18/h.
 *
 * The sentence was false, and the action it recommends — go and cost those
 * hours — is the double-charge the payroll build exists to prevent. Genuinely
 * uncosted: 2 deals, 48 hours.
 *
 * Numbers against constructed inputs, no source text, no database.
 */

const GREG = { id: "e-greg", name: "Tomco Labor - Greg", unratedHours: 250 };
const ROB = { id: "e-rob", name: "Tomco Labor - Rob", unratedHours: 32 };

describe("unratedCoverageFrom", () => {
  it("clears hours whose person has already been paid on this deal", () => {
    const coverage = unratedCoverageFrom(
      [GREG],
      // The payout is recorded against the labor COMPANY's name, differently
      // cased — "tomco labor - greg" on the payment is the same man.
      new Map([["tomco labor - greg", { cents: 12_295_01, n: 7 }]])
    );
    expect(coverage.uncostedHours).toBe(0);
    expect(coverage.coveredByPayoutCents).toBe(12_295_01);
  });

  it("keeps the hours of a person nobody has paid, even when the deal has payouts", () => {
    // The case the deal-level test cannot see: Greg is paid, Rob is not.
    const coverage = unratedCoverageFrom(
      [GREG, ROB],
      new Map([["Tomco Labor - Greg", { cents: 12_295_01, n: 7 }]])
    );
    expect(coverage.uncostedHours).toBe(32);
    expect(coverage.coveredByPayoutCents).toBe(12_295_01);
  });

  it("keeps every hour when the deal has no labor payouts at all", () => {
    // MS Packaging Ceiling Repair (32h) and DuCon-LANDLORD (16h) — the two
    // deals on the live book that really are uncosted.
    expect(unratedCoverageFrom([ROB], new Map()).uncostedHours).toBe(32);
    expect(unratedCoverageFrom([{ ...ROB, unratedHours: 16 }], new Map()).uncostedHours).toBe(16);
  });

  it("sums the hours of several unpaid people", () => {
    const coverage = unratedCoverageFrom(
      [GREG, ROB, { id: "e-jj", name: "Tomco Labor - JJ", unratedHours: 7.5 }],
      new Map([["materials r us", { cents: 500_00, n: 1 }]])
    );
    expect(coverage.uncostedHours).toBe(289.5);
    expect(coverage.coveredByPayoutCents).toBe(0);
  });
});

describe("dealMargin's caveat", () => {
  const cipla = {
    billedPreTaxCents: 88_627_09,
    contractCents: 88_627_09,
    hasContract: true,
    totalCostCents: 55_000_00,
    laborUnratedHours: 1063,
  };

  it("says nothing about 1,063 hours that $36,456.22 of labor already paid for", () => {
    const m = dealMargin({ ...cipla, laborUncostedHours: 0 });
    expect(m.caveat).toBeNull();
  });

  it("does not move the percentage either way — the caveat is a sentence, not a number", () => {
    const quiet = dealMargin({ ...cipla, laborUncostedHours: 0 });
    const loud = dealMargin({ ...cipla, laborUncostedHours: 1063 });
    expect(quiet.pct).toBe(loud.pct);
    expect(quiet.cents).toBe(loud.cents);
    expect(quiet.pct).toBe(38);
  });

  it("still warns about the hours nobody has paid for, and counts only those", () => {
    // DuCon-LANDLORD: 16 of its hours are genuinely uncosted.
    const m = dealMargin({ ...cipla, laborUnratedHours: 1063, laborUncostedHours: 16 });
    expect(m.caveat).toMatch(/\b16 of the crew hours on this job are not costed yet/);
    expect(m.caveat).not.toMatch(/1063/);
    // Never the old advice: setting a rate on a W-2 employee double-counts.
    expect(m.caveat).not.toMatch(/cost rate/i);
  });

  it("keeps the singular for one hour", () => {
    const m = dealMargin({ ...cipla, laborUnratedHours: 1, laborUncostedHours: 1 });
    expect(m.caveat).toMatch(/\b1 of the crew hours on this job is not costed yet/);
  });
});

describe("marginFrom carries the caveat, so an aggregate row cannot print a bare margin", () => {
  it("attaches it for hours nothing has paid for", () => {
    // The geography report's Melville row: 45% margin, 16 uncosted hours.
    const m = marginFrom(1_000_000_00, 550_000_00, 16);
    expect(m.pct).toBe(45);
    expect(m.caveat).toMatch(/^16h of crew time has no cost against it yet/);
    expect(m.caveat).toMatch(/Payroll/);
  });

  it("stays silent for a row whose unrated hours are all paid", () => {
    // 102 of the geography report's 105 live rows.
    expect(marginFrom(1_000_000_00, 550_000_00, 0).caveat).toBeNull();
    expect(marginFrom(1_000_000_00, 550_000_00).caveat).toBeNull();
  });

  it("does not shift the margin it is attached to", () => {
    for (const hours of [0, 16, 14_637]) {
      const m = marginFrom(208_968_477, 122_599_807, hours);
      expect(m.pct, String(hours)).toBe(41);
      expect(m.cents, String(hours)).toBe(86_368_670);
    }
  });

  it("lets the earlier, stronger caveats win", () => {
    // Nothing billed / nothing spent are bigger facts about the number than
    // some uncosted hours, and saying both would be noise.
    expect(marginFrom(0, 5_000_00, 40).caveat).toMatch(/Nothing billed yet/);
    expect(marginFrom(100_00, 0, 40).caveat).toMatch(/No costs booked yet/);
  });
});

describe("the shared sentence refuses to be stated about paid hours", () => {
  it("returns null when every unrated hour is covered", () => {
    expect(unratedHoursNote({ uncostedHours: 0, coveredByPayoutCents: 604_948_35 })).toBeNull();
    expect(unratedHoursShort({ uncostedHours: 0, coveredByPayoutCents: 604_948_35 })).toBeNull();
  });

  it("states the uncosted hours when there are some", () => {
    expect(unratedHoursNote({ uncostedHours: 48, coveredByPayoutCents: 0 })).toMatch(
      /^48h of crew time has no cost against it yet/
    );
    expect(unratedHoursShort({ uncostedHours: 48, coveredByPayoutCents: 0 })).toBe(
      "48h not costed yet — waiting on payroll"
    );
  });

  it("formats a fractional hour count without a wall of decimals", () => {
    expect(unratedHoursNote({ uncostedHours: 1234.5678, coveredByPayoutCents: 0 })).toMatch(/^1,234\.57h/);
  });

  it("noPayoutCoverage means exactly that, and never a negative", () => {
    expect(noPayoutCoverage(48)).toEqual({ uncostedHours: 48, coveredByPayoutCents: 0 });
    expect(noPayoutCoverage(0)).toEqual({ uncostedHours: 0, coveredByPayoutCents: 0 });
    expect(noPayoutCoverage(-3).uncostedHours).toBe(0);
  });
});

/**
 * THE CEO'S EMAIL SHOWED "41% · healthy" AND NOTHING ELSE.
 *
 * `companyPnl` has computed `unratedHours` all along — 14,637 of them on the
 * live book — and `renderDigestEmail` never printed it. The one figure in
 * Alex's inbox carrying a word of reassurance was the one with an unstated
 * overstatement behind it.
 *
 * Printing the raw 14,637 would have been the opposite mistake: 14,589 are
 * already paid for. The line names the payout-gated figure, 48h on 2 jobs.
 */
const digest = (over: Partial<DigestData> = {}): DigestData => ({
  cadence: "monthly",
  windowLabel: "this month",
  fromYmd: "2026-10-01",
  toYmd: "2026-10-16",
  outstandingCents: 0,
  collectibleCents: 0,
  overdueCents: 0,
  retainageCents: 0,
  openItemCount: 0,
  briefText: null,
  briefStale: false,
  inCents: 0,
  outCents: 0,
  netCents: 0,
  txnCount: 0,
  undepositedCents: 0,
  undepositedCount: 0,
  taxCollectedCents: 0,
  uncertifiedCount: 0,
  reimbursementsOwedCents: 0,
  reimbursementsOwedCount: 0,
  readyToBillCents: 0,
  overBilledProjects: 0,
  topGcName: null,
  topGcCents: 0,
  topGcPct: 0,
  over90Cents: 0,
  over90Count: 0,
  oldestDays: 0,
  oldestName: null,
  pnl: {
    grossRevenueCents: 2_089_684_77,
    totalCostCents: 1_225_998_07,
    crewLaborCents: 0,
    netProfitCents: 863_686_70,
    marginPct: 41,
    unratedHours: 14_637,
  },
  ar: [],
  arTotalCents: 0,
  arRetentionCents: 0,
  ...over,
});

describe("the digest's margin tile", () => {
  it("says what is uncosted behind the margin, in both the HTML and the text", () => {
    const { html, text } = renderDigestEmail(digest({ uncostedHours: 48, uncostedDeals: 2 }));
    for (const body of [html, text]) {
      expect(body).toContain("48 crew hours on 2 jobs have no cost against them yet");
      expect(body).toContain("Payroll");
    }
  });

  it("never mails the raw unrated total, which is already paid for", () => {
    const { html, text } = renderDigestEmail(digest({ uncostedHours: 48, uncostedDeals: 2 }));
    // 14,637 is true and useless: acting on it is the double-charge.
    expect(html).not.toContain("14,637");
    expect(text).not.toContain("14,637");
  });

  it("stays quiet when every unrated hour is covered", () => {
    const { html, text } = renderDigestEmail(digest({ uncostedHours: 0, uncostedDeals: 0 }));
    expect(html).not.toContain("Margin reads high");
    expect(text).not.toContain("Margin reads high");
  });

  it("keeps the singular for one job", () => {
    const { text } = renderDigestEmail(digest({ uncostedHours: 16, uncostedDeals: 1 }));
    expect(text).toContain("16 crew hours on 1 job have no cost");
  });
});
