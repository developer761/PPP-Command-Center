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
 * surface when colors are entered, so carrying it here asked the same question
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

  it("never lets a line's NAME disagree with the finishes it offers", () => {
    // This used to forbid any finish word in a line value outright (Kate R4.9:
    // "the finish is already captured at the surface level; carrying it here
    // asks the same question twice and lets the two answers disagree").
    //
    // Jason's Short List (2026-09-10) asks for the opposite on three exterior
    // products — "rename mooreglo soft gloss", "mooreguard low lustre",
    // "moorlife flat" — because that is how the supplier lists them. Karan
    // decided in Jason's favour on 2026-09-10.
    //
    // Kate's REASON still stands, so it is what is guarded now: a name may
    // carry a finish, but only if that is exactly the finish the product is
    // sold in. The two answers then cannot disagree, which was the whole point.
    const FINISHES = ["Flat", "Matte", "Eggshell", "Semi Gloss", "Semi-Gloss",
                      "Satin", "Pearl", "Low Sheen", "Low Lustre", "Soft Gloss", "Gloss"];
    let named = 0;
    for (const line of PAINT_LINES) {
      const inName = FINISHES.filter((f) => line.value.includes(f));
      if (inName.length === 0) continue;
      named++;
      const declared = line.finishes;
      expect(declared, `"${line.value}" names a finish but declares none`).toBeTruthy();
      expect(
        Array.isArray(declared),
        `"${line.value}" names a finish, so it must be sold in exactly one`
      ).toBe(true);
      const list = declared as readonly string[];
      expect(list.length, `"${line.value}" names a finish but offers ${list.length}`).toBe(1);
      expect(
        line.value.includes(list[0]),
        `"${line.value}" offers ${list[0]} — the name says something else`
      ).toBe(true);
    }
    // Prove it measured something: the three renamed exterior products.
    expect(named).toBeGreaterThanOrEqual(3);
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
    // "Moorlife Flat" and "Mooreglo Soft Gloss" both begin "Moore".
    expect(paintLineFromValue("Moorlife Flat")).toBe("Moorlife Flat");
    expect(paintLineFromValue("Mooreglo Soft Gloss")).toBe("Mooreglo Soft Gloss");
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
    expect(options).not.toContain("Mooreglo Soft Gloss");
  });

  it("hides interior-only lines on an exterior job", () => {
    const options = filterMaterialTypesForWorkOrder({ workTypeName: "Exterior Painting" })
      .flatMap((g) => g.options);
    expect(options).toContain("Mooreglo Soft Gloss");
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
