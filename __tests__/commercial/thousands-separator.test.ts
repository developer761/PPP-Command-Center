import { describe, it, expect } from "vitest";
import { group } from "@/components/commercial/grouped-number-input";

/**
 * Brendan 2026-09-23: "when adding the quantity if it's like 1000
 * automatically add a comma, and same goes for everywhere else as well."
 *
 * Reading 12000 off a proposal line and working out whether that is twelve
 * thousand or a hundred and twenty is a check nobody should be doing on a
 * document that becomes a contract.
 *
 * The risk in adding separators is the PARSE, not the display: `Number("1,000")`
 * is NaN, and the quantity handler turned NaN into a silent fallback of 1 — so
 * formatting the box without widening the parser first would have repriced a
 * 1,000-unit line as one unit. That parser is `quantityInputToNumber`; these
 * cover the display half.
 */
describe("thousands separators as you type", () => {
  it("groups whole numbers", () => {
    expect(group("1000")).toBe("1,000");
    expect(group("12000")).toBe("12,000");
    expect(group("1234567")).toBe("1,234,567");
  });

  it("leaves small numbers alone", () => {
    expect(group("1")).toBe("1");
    expect(group("999")).toBe("999");
  });

  it("does not eat a decimal that is still being typed", () => {
    // The dangerous case: reformatting "2.5" as it is typed could produce "25".
    expect(group("1000.")).toBe("1,000.");
    expect(group("1000.5")).toBe("1,000.5");
    expect(group("2.5")).toBe("2.5");
    expect(group("0.25")).toBe("0.25");
  });

  it("is idempotent — typing into an already-grouped value is stable", () => {
    expect(group("1,000")).toBe("1,000");
    expect(group(group(group("1000")))).toBe("1,000");
  });

  it("passes through anything that is not a number, rather than fighting the typist", () => {
    expect(group("")).toBe("");
    expect(group("abc")).toBe("abc");
    expect(group("-5")).toBe("-5");
  });
});
