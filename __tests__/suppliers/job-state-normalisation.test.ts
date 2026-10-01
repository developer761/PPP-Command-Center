import { describe, it, expect } from "vitest";
import { normalizeStateCode } from "@/lib/materials/order-page-data";

/**
 * The job's state, for the vendor picker's "near the job" grouping.
 *
 * Read on its own rather than through the page's `address` object, which is
 * gated on `billingStreet` — reasonable for a delivery address a driver needs,
 * wrong here: a work order can be known to be in Florida without anybody
 * having typed a street.
 */
describe("the job's state code", () => {
  it("passes a two-letter code through, upper-cased", () => {
    expect(normalizeStateCode("FL")).toBe("FL");
    expect(normalizeStateCode("fl")).toBe("FL");
    expect(normalizeStateCode("  ny  ")).toBe("NY");
  });

  it("maps the written-out names Salesforce also carries", () => {
    expect(normalizeStateCode("Florida")).toBe("FL");
    expect(normalizeStateCode("new york")).toBe("NY");
    expect(normalizeStateCode("New Jersey")).toBe("NJ");
  });

  it("returns null for anything it cannot be sure about", () => {
    // Null simply leaves the vendor list in its default order, which is the
    // designed no-op — never a wrong grouping.
    for (const v of [null, undefined, "", "   ", "Unknown", "USA", "N"]) {
      expect(normalizeStateCode(v), String(v)).toBeNull();
    }
  });
});
