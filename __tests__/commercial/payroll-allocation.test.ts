import { describe, it, expect } from "vitest";
import {
  allocatePayrollToJobs,
  allocationSumsTo,
} from "@/lib/commercial/field-ops/payroll-allocation";

/**
 * Katie's worked example, 2026-09-24, is the specification:
 *
 *   "JJ gets paid 500 but gusto actually takes out $520 from the bank...
 *    Job 1 is 20 hours and Job 2 is 10 hours and Job 3 is 10 hours.
 *    She would calculate 520 * 50%, 520 * 25% and 520 * 25%.
 *    The calculated value is the Payout for that work for that job."
 *
 * So the first test below is literally the number Mary would get with a
 * calculator, and the rest are the ways a calculator quietly gets it wrong.
 */
describe("splitting a week's payroll across jobs", () => {
  const J = (opportunityId: string, hours: number) => ({ opportunityId, hours });

  it("matches Katie's example exactly", () => {
    const out = allocatePayrollToJobs(52_000, [J("job1", 20), J("job2", 10), J("job3", 10)]);
    expect(out.map((o) => o.amountCents)).toEqual([26_000, 13_000, 13_000]);
    expect(out.map((o) => Math.round(o.pct))).toEqual([50, 25, 25]);
  });

  it("never loses a penny, however awkward the split", () => {
    // $520 three ways is $173.333… — floor everything and a cent of real money
    // that left the bank lands on no job at all.
    const out = allocatePayrollToJobs(52_000, [J("a", 1), J("b", 1), J("c", 1)]);
    expect(allocationSumsTo(out, 52_000)).toBe(true);
    expect(out.map((o) => o.amountCents).sort()).toEqual([17_333, 17_333, 17_334]);
  });

  it("holds over many shapes, which is the only way to believe it", () => {
    for (const cents of [1, 7, 99, 52_000, 123_457, 999_999]) {
      for (const hrs of [[1], [1, 1], [1, 2, 3], [7, 11, 13, 17], [0.25, 0.5, 40]]) {
        const out = allocatePayrollToJobs(
          cents,
          hrs.map((h, i) => J(`j${i}`, h)),
        );
        expect(allocationSumsTo(out, cents), `${cents} over ${hrs.join("/")}`).toBe(true);
        // and nothing negative, ever
        expect(out.every((o) => o.amountCents >= 0)).toBe(true);
      }
    }
  });

  it("gives the spare penny to the biggest remainder, not the first row", () => {
    // 3 cents over 1h/1h/4h: shares are 0.5, 0.5, 2.0. The two halves have the
    // claim; the exact-2 does not. Paying the list in order would take from a
    // job that was owed a whole number.
    const out = allocatePayrollToJobs(3, [J("a", 1), J("b", 1), J("c", 4)]);
    expect(allocationSumsTo(out, 3)).toBe(true);
    expect(out.find((o) => o.opportunityId === "c")!.amountCents).toBe(2);
  });

  it("ignores jobs with no hours rather than paying them zero", () => {
    const out = allocatePayrollToJobs(10_000, [J("worked", 8), J("untouched", 0)]);
    expect(out).toHaveLength(1);
    expect(out[0].opportunityId).toBe("worked");
    expect(out[0].amountCents).toBe(10_000);
  });

  it("returns nothing when there are no hours to attribute", () => {
    // Paid but worked no job — a week of PTO. Inventing a job for that money is
    // worse than leaving it for a person to place.
    expect(allocatePayrollToJobs(52_000, [])).toEqual([]);
    expect(allocatePayrollToJobs(52_000, [J("a", 0)])).toEqual([]);
  });

  it("returns nothing for a zero or negative liability", () => {
    expect(allocatePayrollToJobs(0, [J("a", 8)])).toEqual([]);
    expect(allocatePayrollToJobs(-500, [J("a", 8)])).toEqual([]);
  });

  it("handles part hours, which attendance records", () => {
    const out = allocatePayrollToJobs(30_000, [J("a", 7.5), J("b", 2.5)]);
    expect(out.map((o) => o.amountCents)).toEqual([22_500, 7_500]);
    expect(allocationSumsTo(out, 30_000)).toBe(true);
  });
});
