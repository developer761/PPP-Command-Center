import { describe, it, expect } from "vitest";
import { toDecimalFeet, fromDecimalFeet, formatFtIn, EMPTY_FT_IN } from "@/components/feet-inches-input";

/**
 * A tape measure reads 12′ 7″. The tool used to demand 12.58.
 *
 * That conversion is a real ask: it happens on a phone, in someone's house,
 * while holding a tape — and getting it slightly wrong (12.7) is a different
 * room. Karan flagged it from the field.
 */
describe("feet and inches → decimal feet", () => {
  it("converts the way a tape reads", () => {
    expect(toDecimalFeet({ feet: "12", inches: "7" })).toBeCloseTo(12.583, 2);
    expect(toDecimalFeet({ feet: "8", inches: "6" })).toBe(8.5);
    expect(toDecimalFeet({ feet: "10", inches: "0" })).toBe(10);
  });

  it("accepts either box alone", () => {
    // Most walls are whole feet; inches-only happens on a bump-out.
    expect(toDecimalFeet({ feet: "12", inches: "" })).toBe(12);
    expect(toDecimalFeet({ feet: "", inches: "9" })).toBeCloseTo(0.75, 3);
  });

  it("returns 0 rather than NaN for anything unusable", () => {
    expect(toDecimalFeet(EMPTY_FT_IN)).toBe(0);
    expect(toDecimalFeet({ feet: "abc", inches: "" })).toBe(0);
    expect(toDecimalFeet({ feet: "-5", inches: "3" })).toBe(0);
    expect(toDecimalFeet({ feet: "", inches: "-2" })).toBe(0);
  });

  it("round-trips a saved measurement back into the boxes", () => {
    expect(fromDecimalFeet(12.583)).toEqual({ feet: "12", inches: "7" });
    expect(fromDecimalFeet(10)).toEqual({ feet: "10", inches: "" });
    expect(fromDecimalFeet(null)).toEqual(EMPTY_FT_IN);
    expect(fromDecimalFeet(0)).toEqual(EMPTY_FT_IN);
  });

  it("carries instead of showing 12 inches", () => {
    // 11.97ft is 11′ 11.6″ — must read 12′, never 11′ 12″.
    expect(fromDecimalFeet(11.97)).toEqual({ feet: "12", inches: "" });
  });

  it("survives the round trip without drifting", () => {
    for (const ft of [8, 10.5, 12.583, 24.25, 6.75]) {
      const back = toDecimalFeet(fromDecimalFeet(ft));
      // Within half an inch — the boxes hold whole inches by design.
      expect(Math.abs(back - ft)).toBeLessThan(0.05);
    }
  });

  it("reads back the way a painter says it", () => {
    expect(formatFtIn({ feet: "12", inches: "7" })).toBe("12′ 7″");
    expect(formatFtIn({ feet: "10", inches: "" })).toBe("10′");
    expect(formatFtIn({ feet: "", inches: "9" })).toBe("9″");
    expect(formatFtIn(EMPTY_FT_IN)).toBe("");
  });
});
