import { describe, it, expect } from "vitest";
import { FINISH_QUICK_REFERENCE } from "@/lib/customer-form/finish-guide";
import { BASE_FINISHES, finishOptionsFor } from "@/lib/customer-form/material-types";

/**
 * PPP's Finish Quick Reference — the table under "Recommended finishes by area
 * or surface" on the color form.
 *
 * Kate, 2026-09-29: "this is the original table — I just want it to be simple
 * like this, and it's much more compact."
 *
 * The rows below ARE the table. What these tests defend is what a block of
 * reference copy gets wrong over time: naming a finish the form will not let
 * the customer pick, or spelling one differently from the dropdown two inches
 * below it.
 */

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
  for (const row of FINISH_QUICK_REFERENCE) {
    it(`"${row.finish}" is a finish the form can actually offer`, () => {
      // A table naming a finish no product sells sends the customer looking
      // for something that is not in the list.
      expect(offeredAnywhere.has(row.finish)).toBe(true);
    });
  }

  it("and the set is big enough that the check means something", () => {
    // If finishOptionsFor ever returned nothing every assertion above would
    // fail rather than pass — but a set of only BASE_FINISHES would make the
    // two exterior rows trivially true. State the size.
    expect(offeredAnywhere.size).toBeGreaterThan(7);
  });

  it("including the two that only exist outdoors", () => {
    const names = FINISH_QUICK_REFERENCE.map((r) => r.finish);
    expect(names).toContain("Low Lustre");
    expect(names).toContain("Soft Gloss");
    // Neither is in the interior base list, so they can only have come from a
    // scoped lookup — the part of this check most likely to rot.
    expect(BASE_FINISHES).not.toContain("Low Lustre");
    expect(BASE_FINISHES).not.toContain("Soft Gloss");
  });
});

describe("the table itself", () => {
  it("is the seven rows Kate sent, in her order", () => {
    expect(FINISH_QUICK_REFERENCE.map((r) => r.finish)).toEqual([
      "Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Low Lustre", "Soft Gloss",
    ]);
  });

  it("gives every row both columns", () => {
    for (const row of FINISH_QUICK_REFERENCE) {
      expect(row.typicalUse, row.finish).toBeTruthy();
      expect(row.characteristics, row.finish).toBeTruthy();
    }
  });

  it("keeps the two rows PPP calls out as its own preference", () => {
    // These sentences are what make it PPP's table rather than a generic sheen
    // chart, and the easiest thing for a later edit to smooth away.
    const semiGloss = FINISH_QUICK_REFERENCE.find((r) => r.finish === "Semi-Gloss")!;
    expect(semiGloss.characteristics).toContain("PPP-preferred trim option");
    const lowLustre = FINISH_QUICK_REFERENCE.find((r) => r.finish === "Low Lustre")!;
    expect(lowLustre.characteristics).toContain("PPP's typical siding recommendation");
  });

  it("puts Satin where the bathrooms are", () => {
    // The row the whole change started from: Kate's original ask was that a
    // bathroom reads Satin rather than Eggshell.
    const satin = FINISH_QUICK_REFERENCE.find((r) => r.finish === "Satin")!;
    expect(satin.typicalUse).toContain("Bathrooms");
  });
});
