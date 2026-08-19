import { describe, it, expect } from "vitest";
import { formatColorLabel } from "@/lib/supplier-order/estimate-gallons";

/**
 * R4.24 — order lines were reading "1421 Bistro Blue 1421" and "Super White
 * Super White", because the renderer appended Code__c to a Name that already
 * contained it. A vendor reasonably reads that as two different things.
 */
describe("formatColorLabel", () => {
  it("doesn't repeat a code the name already starts with", () => {
    expect(formatColorLabel("1421 Bistro Blue", "1421")).toBe("1421 Bistro Blue");
    expect(formatColorLabel("OC-45 Swiss Coffee", "OC-45")).toBe("OC-45 Swiss Coffee");
    expect(formatColorLabel("HC-14 Princeton Gold", "HC-14")).toBe("HC-14 Princeton Gold");
  });

  it("handles the colors whose name IS the code", () => {
    expect(formatColorLabel("Super White", "Super White")).toBe("Super White");
  });

  it("still appends a code the name lacks", () => {
    expect(formatColorLabel("White Dove", "OC-17")).toBe("White Dove OC-17");
  });

  it("matches across inconsistent hyphenation and case", () => {
    // PPP's data hyphenates codes inconsistently; a literal includes() missed these.
    expect(formatColorLabel("HC 14 Princeton Gold", "HC-14")).toBe("HC 14 Princeton Gold");
    expect(formatColorLabel("SUPER WHITE", "Super White")).toBe("SUPER WHITE");
    expect(formatColorLabel("Oc-45 Swiss Coffee", "OC-45")).toBe("Oc-45 Swiss Coffee");
  });

  it("degrades sensibly on missing pieces", () => {
    expect(formatColorLabel("White Dove", null)).toBe("White Dove");
    expect(formatColorLabel(null, "OC-17")).toBe("OC-17");
    expect(formatColorLabel("White Dove", "  ")).toBe("White Dove");
    expect(formatColorLabel(null, null)).toBe("");
    // A punctuation-only code carries no information — don't append "—".
    expect(formatColorLabel("White Dove", "—")).toBe("White Dove");
  });
});
