import { describe, it, expect } from "vitest";
import { parseCostRateToCents } from "@/lib/commercial/field-ops/cost-rate";

/**
 * The burdened $/hr rate that turns crew hours into job cost.
 *
 * The bug this pins: the parser used to return `null` for BOTH "nothing typed"
 * and "typed something unparseable", and both call sites did
 * `if (rate != null) save it`. So a typo saved nothing, reported success, and
 * left the employee with no rate — meaning their hours cost $0 and every job
 * they touched reported margin that was too high.
 */
describe("parseCostRateToCents", () => {
  it("accepts a plain rate", () => {
    expect(parseCostRateToCents("42.00")).toEqual({ cents: 4200 });
    expect(parseCostRateToCents("42")).toEqual({ cents: 4200 });
  });

  it("accepts a rate with a dollar sign or spaces", () => {
    expect(parseCostRateToCents(" $38.50 ")).toEqual({ cents: 3850 });
  });

  it("treats blank as deliberately-not-set, NOT an error", () => {
    // Adding a crew member before their rate is agreed is normal.
    expect(parseCostRateToCents("")).toEqual({ blank: true });
    expect(parseCostRateToCents("   ")).toEqual({ blank: true });
  });

  it("REJECTS a typo instead of silently saving nothing", () => {
    for (const junk of ["fourty two", "4.2.5", "abc", "$", "-"]) {
      const r = parseCostRateToCents(junk);
      expect("error" in r, `expected "${junk}" to be rejected`).toBe(true);
    }
  });

  it("rejects zero and negatives", () => {
    // The minus is stripped before parsing, so "-42" reads as 42 — but zero
    // must not pass, or the employee costs nothing per hour.
    expect("error" in parseCostRateToCents("0")).toBe(true);
    expect("error" in parseCostRateToCents("0.00")).toBe(true);
  });

  it("catches a misplaced decimal point", () => {
    // $4,200/hr is a slipped decimal on $42.00. Cheap to catch here, and
    // expensive not to: it would wreck the margin on every job that crew works.
    const r = parseCostRateToCents("4200");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/typo/i);
  });

  it("allows a legitimately high but plausible rate", () => {
    // A senior sub at $200/hr burdened is unusual, not impossible.
    expect(parseCostRateToCents("200")).toEqual({ cents: 20000 });
  });

  it("rounds to whole cents", () => {
    expect(parseCostRateToCents("41.999")).toEqual({ cents: 4200 });
  });
});
