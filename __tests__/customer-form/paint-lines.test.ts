import { describe, it, expect } from "vitest";
import {
  PAINT_LINES,
  PAINT_LINE_VALUES,
  PRIMER_MATERIAL_VALUES,
  VALID_MATERIAL_TYPE_VALUES,
  MATERIAL_TYPES,
  paintLineFromValue,
  filterMaterialTypesForWorkOrder,
} from "@/lib/customer-form/material-types";

/**
 * Kate round-3 #08 + #09.
 *
 * #09: the product-line picker lists LINES only. The finish is captured per
 * surface when colours are entered, so carrying it here asked the same question
 * twice and let the two answers disagree.
 *
 * #08: primers are Extras on the order screen, never a topcoat line. Round 2
 * removed them from the order page's pickers but not from the entry form's.
 */

describe("paint line picklist (#09)", () => {
  it("offers the lines Kate named", () => {
    for (const line of ["Ultra Spec", "Regal Select", "Ben", "Aura"]) {
      expect(PAINT_LINE_VALUES.has(line)).toBe(true);
    }
  });

  it("carries no finish in any line value", () => {
    const finishes = ["Flat", "Matte", "Eggshell", "Semi Gloss", "Satin", "Low Sheen", "Soft Gloss"];
    for (const line of PAINT_LINES) {
      for (const finish of finishes) {
        expect(
          line.value.includes(finish),
          `"${line.value}" still names a finish — the finish belongs on the surface`
        ).toBe(false);
      }
    }
  });

  it("contains no primers (#08)", () => {
    for (const line of PAINT_LINES) {
      expect(PRIMER_MATERIAL_VALUES.has(line.value)).toBe(false);
    }
  });
});

describe("paintLineFromValue", () => {
  it("collapses legacy line+finish values to their line", () => {
    expect(paintLineFromValue("Regal Select Eggshell")).toBe("Regal Select");
    expect(paintLineFromValue("Ultra Spec Interior Flat")).toBe("Ultra Spec");
    expect(paintLineFromValue("Ultra Spec Exterior Satin")).toBe("Ultra Spec");
    expect(paintLineFromValue("Aura Bath & Spa Matte")).toBe("Aura");
  });

  it("passes a line-only value straight through", () => {
    for (const line of PAINT_LINE_VALUES) {
      expect(paintLineFromValue(line)).toBe(line);
    }
  });

  it("never collapses a primer into a topcoat line", () => {
    // "Ultra Spec Exterior Primer" starts with "Ultra Spec" and must NOT
    // become it — a primer is a different product, ordered separately.
    expect(paintLineFromValue("Ultra Spec Exterior Primer")).toBe("Ultra Spec Exterior Primer");
    expect(paintLineFromValue("Fresh Start Latex 046")).toBe("Fresh Start Latex 046");
  });

  it("distinguishes lines that share a prefix", () => {
    // "Moore Life" and "Mooreglo" both begin "Moore".
    expect(paintLineFromValue("Moore Life")).toBe("Moore Life");
    expect(paintLineFromValue("Mooreglo")).toBe("Mooreglo");
  });

  it("leaves an unrecognised Salesforce value alone rather than blanking it", () => {
    expect(paintLineFromValue("Some Hand-Typed Thing")).toBe("Some Hand-Typed Thing");
  });

  it("handles empty input", () => {
    expect(paintLineFromValue(null)).toBe("");
    expect(paintLineFromValue(undefined)).toBe("");
    expect(paintLineFromValue("   ")).toBe("");
  });
});

describe("back-compat", () => {
  it("still validates legacy values so old work orders don't get rejected", () => {
    for (const legacy of MATERIAL_TYPES) {
      expect(VALID_MATERIAL_TYPE_VALUES.has(legacy.value)).toBe(true);
    }
  });

  it("validates the new line-only values too", () => {
    for (const line of PAINT_LINE_VALUES) {
      expect(VALID_MATERIAL_TYPE_VALUES.has(line)).toBe(true);
    }
  });
});

describe("per-work-order filtering", () => {
  it("hides exterior-only lines on an interior job", () => {
    const options = filterMaterialTypesForWorkOrder({ workTypeName: "Interior Painting" })
      .flatMap((g) => g.options);
    expect(options).toContain("Regal Select");
    expect(options).not.toContain("Mooreglo");
  });

  it("hides interior-only lines on an exterior job", () => {
    const options = filterMaterialTypesForWorkOrder({ workTypeName: "Exterior Painting" })
      .flatMap((g) => g.options);
    expect(options).toContain("Mooreglo");
    expect(options).not.toContain("Ben");
  });

  it("shows everything on a mixed or unknown job", () => {
    const options = filterMaterialTypesForWorkOrder({ workTypeName: null }).flatMap((g) => g.options);
    expect(options).toEqual([...PAINT_LINE_VALUES]);
  });

  it("never offers a primer (#08)", () => {
    for (const workTypeName of ["Interior Painting", "Exterior Painting", null]) {
      const options = filterMaterialTypesForWorkOrder({ workTypeName }).flatMap((g) => g.options);
      for (const o of options) expect(PRIMER_MATERIAL_VALUES.has(o)).toBe(false);
    }
  });
});
