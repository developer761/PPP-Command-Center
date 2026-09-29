import { describe, it, expect } from "vitest";
import {
  FINISH_GUIDE_INTRO,
  INTERIOR_FINISHES,
  EXTERIOR_FINISHES,
} from "@/lib/customer-form/finish-guide";
import { BASE_FINISHES, finishOptionsFor } from "@/lib/customer-form/material-types";
import { recommendedFinishes } from "@/lib/customer-form/recommended-finish";

/**
 * PPP's finish reference — the table under "Recommended finishes by area or
 * surface" on the color form, in Kate's revised wording (2026-09-29).
 *
 * The rows ARE the table. These tests defend what a block of reference copy
 * gets wrong over time: naming a finish the form will not let the customer
 * pick, spelling one differently from the dropdown two inches below it, or —
 * the one that actually bit — saying something the form's own default
 * contradicts.
 */

const ALL_ROWS = [...INTERIOR_FINISHES, ...EXTERIOR_FINISHES];

/** Every finish the pickers can offer anywhere, in the pickers' own spelling. */
const offeredAnywhere = new Set<string>([
  ...BASE_FINISHES,
  ...(["interior", "exterior"] as const).flatMap((scope) =>
    ["", "Regal Select", "Aura", "Ben", "Ultra Spec", "Mooreglo", "Mooregard", "Moore Life",
     "Aura Bath & Spa", "Regal Select Kitchen & Bath", "SW Emerald", "SW Duration", "SW Super Paint"]
      .flatMap((product) => finishOptionsFor(BASE_FINISHES, product, scope))
  ),
]);

describe("every finish the table names", () => {
  for (const row of ALL_ROWS) {
    it(`"${row.finish}" is a finish the form can actually offer`, () => {
      expect(offeredAnywhere.has(row.finish)).toBe(true);
    });
  }

  it("and the set is big enough that the check means something", () => {
    expect(offeredAnywhere.size).toBeGreaterThan(7);
  });

  it("keeps the two names that only exist outdoors out of the interior list", () => {
    const interior = INTERIOR_FINISHES.map((r) => r.finish);
    expect(interior).not.toContain("Low Lustre");
    expect(interior).not.toContain("Soft Gloss");
    const exterior = EXTERIOR_FINISHES.map((r) => r.finish);
    expect(exterior).toContain("Low Lustre");
    expect(exterior).toContain("Soft Gloss");
  });
});

describe("the table as Kate wrote it", () => {
  it("is her six interior rows, least shine to most", () => {
    expect(INTERIOR_FINISHES.map((r) => r.finish)).toEqual([
      "Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Gloss",
    ]);
  });

  it("and her three exterior rows", () => {
    expect(EXTERIOR_FINISHES.map((r) => r.finish)).toEqual(["Flat", "Low Lustre", "Soft Gloss"]);
  });

  it("opens with the line that explains the whole scale", () => {
    expect(FINISH_GUIDE_INTRO).toContain("More shine means more durable");
    expect(FINISH_GUIDE_INTRO).toContain("Less shine hides flaws better");
  });

  it("gives every row somewhere it goes and something it does", () => {
    for (const row of ALL_ROWS) {
      expect(row.where, row.finish).toBeTruthy();
      expect(row.description, row.finish).toBeTruthy();
    }
  });
});

describe("the table and the form's own defaults agree", () => {
  /**
   * The point of the section. A customer reading "Eggshell — bathroom
   * ceilings" two inches above a dropdown we defaulted to Satin is exactly the
   * disagreement it was built to end — and that is not hypothetical: the
   * default WAS Satin until Kate's revision moved it.
   */
  it("bathroom ceilings: the table says Eggshell and the form fills Eggshell", () => {
    const row = INTERIOR_FINISHES.find((r) => r.finish === "Eggshell")!;
    expect(row.where).toContain("bathroom ceilings");
    expect(recommendedFinishes("Ceiling", "Bathroom", "interior")[0]).toBe("Eggshell");
  });

  it("bathroom walls: the table says Satin and the form fills Satin", () => {
    const row = INTERIOR_FINISHES.find((r) => r.finish === "Satin")!;
    expect(row.where).toContain("Bathrooms");
    expect(recommendedFinishes("Walls", "Bathroom", "interior")[0]).toBe("Satin");
  });

  it("main-area ceilings: the table says most rooms and the form fills Flat", () => {
    const row = INTERIOR_FINISHES.find((r) => r.finish === "Flat")!;
    expect(row.where).toContain("Ceilings in most rooms");
    expect(recommendedFinishes("Ceiling", "Living Room", "interior")[0]).toBe("Flat");
  });

  it("trim: the table says trim and doors, and the form fills Semi-Gloss", () => {
    const row = INTERIOR_FINISHES.find((r) => r.finish === "Semi-Gloss")!;
    expect(row.where).toContain("Trim");
    expect(recommendedFinishes("Trim", "Living Room", "interior")[0]).toBe("Semi-Gloss");
  });

  it("siding: the table says siding and the form fills Low Lustre", () => {
    const row = EXTERIOR_FINISHES.find((r) => r.finish === "Low Lustre")!;
    expect(row.where).toContain("siding");
    expect(recommendedFinishes("Walls", "Exterior", "exterior")[0]).toBe("Low Lustre");
  });

  it("exterior trim and soffits: the table says so and the form fills Soft Gloss", () => {
    const row = EXTERIOR_FINISHES.find((r) => r.finish === "Soft Gloss")!;
    expect(row.where).toContain("soffits");
    expect(recommendedFinishes("Trim", "Exterior", "exterior")[0]).toBe("Soft Gloss");
    expect(recommendedFinishes("Soffit", "Exterior", "exterior")[0]).toBe("Soft Gloss");
  });
});
