import { describe, it, expect } from "vitest";
import {
  INTERIOR_FINISHES,
  EXTERIOR_FINISHES,
  SHEEN_MAX,
} from "@/lib/customer-form/finish-guide";
import { BASE_FINISHES, finishOptionsFor } from "@/lib/customer-form/material-types";

/**
 * "Recommended finishes by area or surface" — the table Kate asked for on
 * 2026-09-29, replacing the recommendation that used to sit under every
 * surface's finish dropdown.
 *
 * The rows below are Mac's copy. What these tests defend is the thing a table
 * of reference copy is most likely to get wrong over time: telling a customer
 * about a finish the form will not let them pick, or spelling one differently
 * from the dropdown two inches below it.
 */

const ALL_SCOPES = ["interior", "exterior"] as const;

/** Every finish the pickers can offer anywhere, in the pickers' own spelling. */
const offeredAnywhere = new Set<string>([
  ...BASE_FINISHES,
  ...ALL_SCOPES.flatMap((scope) =>
    ["", "Regal Select", "Aura", "Ben", "Ultra Spec", "Mooreglo", "Mooregard", "Moore Life",
     "Aura Bath & Spa", "Regal Select Kitchen & Bath", "SW Emerald", "SW Duration", "SW Super Paint"]
      .flatMap((product) => finishOptionsFor(BASE_FINISHES, product, scope))
  ),
]);

describe("every finish the guide names", () => {
  for (const row of [...INTERIOR_FINISHES, ...EXTERIOR_FINISHES]) {
    it(`"${row.finish}" is a finish the form can actually offer`, () => {
      // A guide that recommends Pearl while no product sells it sends the
      // customer looking for something that is not in the list.
      expect(offeredAnywhere.has(row.finish)).toBe(true);
    });
  }

  it("and the set is big enough that the check means something", () => {
    // If finishOptionsFor ever returned nothing, every assertion above would
    // fail rather than pass — but if BASE_FINISHES alone carried them the
    // test would be trivially true. State the size.
    expect(offeredAnywhere.size).toBeGreaterThan(7);
  });
});

describe("the sheen scale", () => {
  it("runs from least light reflected to most, in order", () => {
    // The table's whole organizing idea, and the bar beside each row draws
    // straight from it. Out of order, the bars would contradict the heading.
    const levels = INTERIOR_FINISHES.map((r) => r.sheen);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    expect(new Set(levels).size).toBe(levels.length);
  });

  it("never exceeds the maximum the bar divides by", () => {
    for (const row of [...INTERIOR_FINISHES, ...EXTERIOR_FINISHES]) {
      expect(row.sheen, row.finish).toBeGreaterThanOrEqual(1);
      expect(row.sheen, row.finish).toBeLessThanOrEqual(SHEEN_MAX);
    }
  });

  it("starts at Flat and ends at Gloss", () => {
    expect(INTERIOR_FINISHES[0].finish).toBe("Flat");
    expect(INTERIOR_FINISHES[INTERIOR_FINISHES.length - 1].finish).toBe("Gloss");
  });
});

describe("what each row says", () => {
  it("every interior row describes both the look and the place", () => {
    for (const row of INTERIOR_FINISHES) {
      expect(row.looksLike, row.finish).toBeTruthy();
      expect(row.where, row.finish).toBeTruthy();
    }
  });

  it("every exterior row names the surface it belongs on", () => {
    // The exterior rows pair a place with a reason instead of a "looks like".
    for (const row of EXTERIOR_FINISHES) {
      expect(row.place, row.finish).toBeTruthy();
      expect(row.where, row.finish).toBeTruthy();
    }
  });

  it("carries the two exterior names that never appear indoors", () => {
    const ext = EXTERIOR_FINISHES.map((r) => r.finish);
    expect(ext).toContain("Low Lustre");
    expect(ext).toContain("Soft Gloss");
    const int = INTERIOR_FINISHES.map((r) => r.finish);
    expect(int).not.toContain("Low Lustre");
    expect(int).not.toContain("Soft Gloss");
  });

  it("spells trim's finish the American way", () => {
    // Mac's doc spells it the British way; PPP writes American (Karan
    // 2026-09-29), and the spelling guard covers this file.
    const semiGloss = INTERIOR_FINISHES.find((r) => r.finish === "Semi-Gloss")!;
    expect(semiGloss.where).toContain("crown molding");
  });
});
