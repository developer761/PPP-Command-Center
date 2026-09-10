import { describe, it, expect } from "vitest";
import { paintLineListsFor, finishOptionsFor, BASE_FINISHES, PAINT_LINES } from "@/lib/customer-form/material-types";

/**
 * Jason §3: "There is no stain product in the system anywhere. This is what
 * caused the rear-deck error."
 *
 * Adding them is only half the job. There are TWO product arrays in this file —
 * PAINT_LINES, which the picker walks, and MATERIAL_TYPES, the legacy
 * finish-bearing vocabulary kept for validation. The stains first landed in
 * MATERIAL_TYPES, so `finishOptionsFor` resolved their opacities correctly and
 * nobody could ever select one. Every test passed.
 */
const exteriorJob = { workTypeName: "Exterior Painting", lineItemProductNames: ["Exterior Painting"] };
const interiorJob = { workTypeName: "Interior Painting", lineItemProductNames: ["Interior Painting"] };

const optionsOn = (lists: ReturnType<typeof paintLineListsFor>, side: "interior" | "exterior") =>
  (lists[side] ?? []).flatMap((g) => g.options);

describe("stains are actually selectable", () => {
  it("exterior stains appear in the exterior picker", () => {
    const offered = optionsOn(paintLineListsFor(exteriorJob), "exterior");
    for (const p of ["Woodluxe Water-Based Stain", "Woodluxe Oil-Based Stain", "SW SuperDeck Stain"]) {
      expect(offered, p).toContain(p);
    }
  });

  it("interior stains appear in the interior picker", () => {
    const offered = optionsOn(paintLineListsFor(interiorJob), "interior");
    for (const p of ["Minwax Stain", "Old Masters Stain"]) {
      expect(offered, p).toContain(p);
    }
  });

  it("and an exterior stain never offers a sheen", () => {
    // The rear deck, in one assertion.
    const opts = finishOptionsFor(BASE_FINISHES, "Woodluxe Water-Based Stain", "exterior");
    expect(opts).toEqual(["Transparent", "Translucent", "Semi-Transparent", "Semi-Solid", "Solid"]);
    for (const sheen of BASE_FINISHES) expect(opts, sheen).not.toContain(sheen);
  });

  it("oil has no Solid — Jason: solid is water only", () => {
    expect(finishOptionsFor(BASE_FINISHES, "Woodluxe Oil-Based Stain", "exterior")).not.toContain("Solid");
    expect(finishOptionsFor(BASE_FINISHES, "Woodluxe Water-Based Stain", "exterior")).toContain("Solid");
  });

  it("every product that declares finishes is reachable in the picker", () => {
    // The general form of the bug: a product with a finish list that no picker
    // walks. Both scopes are checked because a product is filtered by category.
    const reachable = new Set([
      ...optionsOn(paintLineListsFor(interiorJob), "interior"),
      ...optionsOn(paintLineListsFor(exteriorJob), "exterior"),
    ]);
    const orphaned = PAINT_LINES.filter((m) => m.finishes && !reachable.has(m.value)).map((m) => m.value);
    expect(orphaned).toEqual([]);
    expect(reachable.size).toBeGreaterThan(10); // prove it measured something
  });
});
