import { describe, it, expect } from "vitest";
import {
  ALL_FINISH_VALUES, BASE_FINISHES, PAINT_LINES, MATERIAL_TYPES, finishOptionsFor,
} from "@/lib/customer-form/material-types";

/**
 * The submit route rejects any finish not in its allowlist, with a 400 that
 * tells the customer their own valid choice is invalid.
 *
 * On 2026-09-09 the picker and that allowlist drifted: Jason's per-product
 * lists added "Pearl" (Regal Select, Ben) and "Velvet" (SW Super Paint) to the
 * dropdown while the server list was still hand-typed and rejected both. It
 * SHIPPED. Nothing caught it, because every test checked one side or the other.
 *
 * This walks every product the picker can show, in every scope, and asserts the
 * server would accept every option offered. It is the seam, not the file.
 */
const PRODUCTS: Array<string | null> = [
  ...PAINT_LINES.map((l) => l.value),
  ...MATERIAL_TYPES.map((m) => m.value),
  null,
];
const SCOPES = [null, "interior", "exterior"] as const;

describe("the picker can never offer something the server rejects", () => {
  it("holds for every product in every scope", () => {
    const rejected: string[] = [];
    let checked = 0;
    for (const product of PRODUCTS) {
      for (const scope of SCOPES) {
        for (const finish of finishOptionsFor(BASE_FINISHES, product, scope)) {
          checked++;
          if (!ALL_FINISH_VALUES.has(finish)) {
            rejected.push(`${product ?? "(none)"}${scope ? ` [${scope}]` : ""}: "${finish}"`);
          }
        }
      }
    }
    // Prove it measured something — a typo in PRODUCTS would silently pass.
    expect(checked).toBeGreaterThan(150);
    expect(rejected).toEqual([]);
  });

  it("covers the values Jason's answers added", () => {
    // The exact two that shipped broken.
    expect(ALL_FINISH_VALUES.has("Pearl")).toBe(true);
    expect(ALL_FINISH_VALUES.has("Velvet")).toBe(true);
    // ...and every stain opacity, which would 400 the same way.
    for (const o of ["Transparent", "Translucent", "Semi-Transparent", "Semi-Solid", "Solid"]) {
      expect(ALL_FINISH_VALUES.has(o), o).toBe(true);
    }
  });

  it("still accepts the legacy combined labels", () => {
    // A form filled in before the Flat/Matte split must still submit.
    expect(ALL_FINISH_VALUES.has("Flat / Matte")).toBe(true);
    expect(ALL_FINISH_VALUES.has("Gloss / High-Gloss")).toBe(true);
  });
});
