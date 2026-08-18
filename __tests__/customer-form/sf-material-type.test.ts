import { describe, it, expect } from "vitest";
import {
  toSalesforceMaterialType,
  SF_MATERIAL_TYPE_VALUES,
  PAINT_LINE_VALUES,
} from "@/lib/customer-form/material-types";

/**
 * WorkOrder.MaterialType__c is a RESTRICTED picklist. Read from the live org:
 *
 *   Ultra Spec Interior · Regal Select Interior · Aura Interior
 *   Ultra Spec Exterior · Regal Select Exterior · Aura Exterior
 *   SW Emerald · SW Duration · SW Super Paint · Other
 *
 * It is line + SCOPE. The app's old values carried a FINISH ("Regal Select
 * Eggshell") and the new ones carry no scope ("Regal Select"), so BOTH were
 * rejected — every write to this field failed for over a month, silently,
 * discoverable only in sf_writes_audit.
 *
 * The rule these tests pin: never send a value the picklist will reject.
 */

const INTERIOR = { workTypeName: "Interior Painting" };
const EXTERIOR = { workTypeName: "Exterior Painting" };
const UNKNOWN = { workTypeName: null };

describe("toSalesforceMaterialType", () => {
  it("adds the scope the org expects", () => {
    expect(toSalesforceMaterialType("Regal Select", INTERIOR)).toBe("Regal Select Interior");
    expect(toSalesforceMaterialType("Ultra Spec", EXTERIOR)).toBe("Ultra Spec Exterior");
    expect(toSalesforceMaterialType("Aura", INTERIOR)).toBe("Aura Interior");
  });

  it("passes through values that already speak Salesforce", () => {
    for (const v of ["SW Emerald", "SW Duration", "SW Super Paint", "Other"]) {
      expect(toSalesforceMaterialType(v, INTERIOR)).toBe(v);
    }
  });

  it("translates a LEGACY finish-bearing value — the ones that were failing", () => {
    expect(toSalesforceMaterialType("Regal Select Eggshell", INTERIOR)).toBe("Regal Select Interior");
    expect(toSalesforceMaterialType("Ultra Spec Interior Flat", INTERIOR)).toBe("Ultra Spec Interior");
    expect(toSalesforceMaterialType("Aura Bath & Spa Matte", INTERIOR)).toBe("Aura Interior");
  });

  it("defaults an unknown-scope job to Interior rather than refusing", () => {
    // Interior is the overwhelming majority of PPP's work.
    expect(toSalesforceMaterialType("Regal Select", UNKNOWN)).toBe("Regal Select Interior");
  });

  it("returns null rather than guessing when the org has no such value", () => {
    // Ben / Mooreglo / Mooregard / Moore Life are real BM lines with no
    // picklist entry. Recording the WRONG paint on a live job is worse than
    // recording none, so the caller skips the write.
    for (const v of ["Ben", "Mooreglo", "Mooregard", "Moore Life"]) {
      expect(toSalesforceMaterialType(v, INTERIOR)).toBeNull();
    }
  });

  it("returns null for empty input", () => {
    expect(toSalesforceMaterialType(null, INTERIOR)).toBeNull();
    expect(toSalesforceMaterialType("", INTERIOR)).toBeNull();
    expect(toSalesforceMaterialType("   ", INTERIOR)).toBeNull();
  });

  it("NEVER returns a value outside the org's picklist — for any line, any scope", () => {
    for (const line of PAINT_LINE_VALUES) {
      for (const ctx of [INTERIOR, EXTERIOR, UNKNOWN]) {
        const out = toSalesforceMaterialType(line, ctx);
        if (out !== null) {
          expect(
            SF_MATERIAL_TYPE_VALUES.has(out),
            `"${line}" mapped to "${out}", which Salesforce would reject`
          ).toBe(true);
        }
      }
    }
  });
});
