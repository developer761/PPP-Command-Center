import { describe, it, expect } from "vitest";
import { toMinutes, hoursBetween } from "@/lib/commercial/field-ops/schedule";

/**
 * The maths behind "they are already on another job at that time".
 *
 * Nothing stopped one painter being scheduled on two jobs at once. The unique
 * key is (job, employee, day) — per JOB — and the day panel's "already on this
 * day" hint is keyed on employee AND job, so picking a second job showed
 * nothing and the form saved its 7–3 default.
 *
 * The damage is downstream: the crew Daily Log pre-fills both jobs at 8h, two
 * taps of Confirm files two 8h entries, and Approvals compares each row to ITS
 * OWN job's assignment — so both read variance 0 and render green. A sixteen
 * hour day, on a screen actively saying it is fine.
 *
 * `toMinutes` has to agree with `hoursBetween` about when a shift ends, or an
 * overnight shift would either escape the check or block the next morning.
 */
describe("overlap arithmetic", () => {
  const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) => {
    const as = toMinutes(aStart)!;
    const ae = toMinutes(aEnd, as)!;
    const bs = toMinutes(bStart)!;
    const be = toMinutes(bEnd, bs)!;
    return as < be && bs < ae;
  };

  it("catches the default case — two 7-to-3 shifts on one day", () => {
    expect(overlaps("07:00", "15:00", "07:00", "15:00")).toBe(true);
  });

  it("catches a partial overlap at either end", () => {
    expect(overlaps("07:00", "15:00", "14:00", "18:00")).toBe(true);
    expect(overlaps("13:00", "18:00", "07:00", "15:00")).toBe(true);
  });

  it("allows back-to-back shifts that only touch", () => {
    // 7–3 then 3–11 is a double, not a conflict: nobody is in two places.
    expect(overlaps("07:00", "15:00", "15:00", "23:00")).toBe(false);
    expect(overlaps("15:00", "23:00", "07:00", "15:00")).toBe(false);
  });

  it("allows two genuinely separate shifts", () => {
    expect(overlaps("07:00", "11:00", "13:00", "17:00")).toBe(false);
  });

  it("treats an end before its start as the next day, like hoursBetween", () => {
    // 22:00–06:00 is an overnight shift, 8 hours long — not a negative one.
    expect(hoursBetween("22:00", "06:00")).toBe(8);
    const s = toMinutes("22:00")!;
    expect(toMinutes("06:00", s)! - s).toBe(8 * 60);
  });

  it("catches an overnight shift overlapping the evening before", () => {
    expect(overlaps("22:00", "06:00", "20:00", "23:30")).toBe(true);
  });

  it("does not block the following morning after an overnight shift", () => {
    // 22:00–06:00 ends at 06:00 the next day; a 07:00 start is clear.
    expect(overlaps("22:00", "06:00", "07:00", "15:00")).toBe(false);
  });

  it("returns null for times it cannot read rather than guessing zero", () => {
    // Zero would read as midnight and make everything overlap.
    expect(toMinutes("")).toBeNull();
    expect(toMinutes(null)).toBeNull();
    expect(toMinutes("not a time")).toBeNull();
  });
});
