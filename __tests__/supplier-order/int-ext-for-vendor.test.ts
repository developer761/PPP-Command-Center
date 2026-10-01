import { describe, it, expect } from "vitest";
import { materialTypeForVendorScoped } from "@/lib/customer-form/material-types";

/**
 * Katie, 2026-10-01: "Need 'INT' and 'EXT' appended to the product lines so
 * vendors know whether to use UltraSpec Interior or UltraSpec Exterior."
 *
 * The vendor cannot see the work order, so a bare "Ultra Spec" on a paint
 * counter is a question — and the two answers are different cans.
 */
describe("what the vendor reads on the product line", () => {
  it("appends INT and EXT to a scope-agnostic product", () => {
    expect(materialTypeForVendorScoped("Ultra Spec", "interior")).toBe("Ultra Spec INT");
    expect(materialTypeForVendorScoped("Ultra Spec", "exterior")).toBe("Ultra Spec EXT");
    expect(materialTypeForVendorScoped("SW Duration", "exterior")).toBe("SW Duration EXT");
  });

  it("appends nothing when the name already says which", () => {
    // "Ultra Spec Interior INT" reads like a typo.
    expect(materialTypeForVendorScoped("Ultra Spec Interior", "interior")).toBe("Ultra Spec Interior");
    expect(materialTypeForVendorScoped("Ultra Spec Exterior", "exterior")).toBe("Ultra Spec Exterior");
    expect(materialTypeForVendorScoped("Ultra Spec Exterior Soft Gloss", "exterior")).toBe(
      "Ultra Spec Exterior Soft Gloss"
    );
  });

  it("appends nothing when the job does not say", () => {
    // A color used on BOTH sides, or a job with no scope signal. A guessed
    // INT on exterior work buys the wrong paint — worse than making somebody
    // ask.
    expect(materialTypeForVendorScoped("Ultra Spec", null)).toBe("Ultra Spec");
    expect(materialTypeForVendorScoped("Ultra Spec", undefined)).toBe("Ultra Spec");
  });

  it("leaves an unanswered product unanswered", () => {
    // A bare "Other" still resolves to "" so the line groups under [NOT SET]
    // rather than telling a vendor the product is "Other INT".
    expect(materialTypeForVendorScoped("Other", "interior")).toBe("");
    expect(materialTypeForVendorScoped("", "interior")).toBe("");
    expect(materialTypeForVendorScoped(null, "exterior")).toBe("");
  });

  it("keeps a typed 'Other: …' product and scopes it", () => {
    expect(materialTypeForVendorScoped("Other: Behr Premium Plus", "interior")).toBe(
      "Behr Premium Plus INT"
    );
  });
});
