import { describe, it, expect } from "vitest";
import { finishOptionsFor, isExteriorProduct } from "@/lib/customer-form/material-types";
import { normalizeFinishToSf, denormalizeFinishFromSf } from "@/lib/customer-form/surface-mapping";

/**
 * Kate 2026-09-09: "the team need Low Lustre and Soft Gloss as available
 * finishes for exterior line items."
 *
 * Both were already ACTIVE on Salesforce's restricted Finish*__c picklists —
 * verified against the live describe — so this is the app catching up, not a
 * Salesforce change. The finish fields are `restricted: true`, which means an
 * option the picker offers but Salesforce does not accept is not a cosmetic
 * mismatch: the write is REJECTED and the colors silently fail to land.
 */
const BASE = ["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Gloss", "High-Gloss"];

describe("exterior sheens", () => {
  it("offers Low Lustre and Soft Gloss on an exterior product", () => {
    const out = finishOptionsFor(BASE, "Ultra Spec Exterior Soft Gloss");
    expect(out).toContain("Low Lustre");
    expect(out).toContain("Soft Gloss");
  });

  it("offers exactly what Jason said each exterior product is sold in", () => {
    // 2026-09-09: he narrowed these to ONE sheen each. That is the point of
    // the exercise — before this every product offered all seven.
    expect(finishOptionsFor(BASE, "Mooreglo")).toEqual(["Soft Gloss"]);
    expect(finishOptionsFor(BASE, "Mooregard")).toEqual(["Low Lustre"]);
    expect(finishOptionsFor(BASE, "Moore Life")).toEqual(["Flat"]);
    expect(finishOptionsFor(BASE, "Regal Select High Build")).toEqual(["Flat", "Low Lustre", "Soft Gloss"]);
    for (const line of ["Mooreglo", "Mooregard", "Moore Life", "Regal Select High Build"]) {
      expect(isExteriorProduct(line), line).toBe(true);
    }
  });

  it("does NOT put them on interior lines — BM does not sell them there", () => {
    for (const line of ["Regal Select", "Aura Bath & Spa Matte", "Ben"]) {
      const out = finishOptionsFor(BASE, line);
      expect(out, line).not.toContain("Low Lustre");
      expect(out, line).not.toContain("Soft Gloss");
    }
    expect(finishOptionsFor(BASE, null)).toEqual(BASE);
  });

  it("still strips the interior-only sheens from an exterior STAIN", () => {
    // Katie item 19 — a rear deck ordered in eggshell. That rule has to keep
    // working now that exterior products append sheens rather than replace.
    const out = finishOptionsFor(BASE, "Arborcoat Semi-Transparent Stain");
    for (const gone of ["Flat", "Matte", "Eggshell"]) expect(out).not.toContain(gone);
  });

  it("survives the round trip to Salesforce and back", () => {
    for (const f of ["Low Lustre", "Soft Gloss"]) {
      // The exact strings Salesforce's picklist holds.
      expect(normalizeFinishToSf(f)).toBe(f);
      expect(denormalizeFinishFromSf(f)).toBe(f);
    }
  });

  it("every finish an exterior job can pick actually reaches Salesforce", () => {
    // The seam that matters: an option the picker shows but normalizeFinishToSf
    // maps to null is written as an EMPTY finish — the color lands, the sheen
    // vanishes, and nobody is told. "High-Gloss" is the known, deliberate
    // exception (no SF picklist value exists for it).
    // Mooreglo is Soft Gloss only now, so nothing is lost there.
    expect(finishOptionsFor(BASE, "Mooreglo").filter((f) => normalizeFinishToSf(f) === null)).toEqual([]);

    // SW Super Paint is the one that still loses a sheen, in BOTH scopes, and
    // it is not a mapping bug: neither value exists on Salesforce's restricted
    // picklist. Pinned so the day Katie adds them, this test says so.
    expect(
      finishOptionsFor(BASE, "SW Super Paint", "interior").filter((f) => normalizeFinishToSf(f) === null)
    ).toEqual(["Velvet"]);
    expect(
      finishOptionsFor(BASE, "SW Super Paint", "exterior").filter((f) => normalizeFinishToSf(f) === null)
    ).toEqual(["High-Gloss"]);
  });
});
