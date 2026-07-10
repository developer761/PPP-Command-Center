import { describe, it, expect } from "vitest";
import {
  classifySurface,
  normalizeFinishToSf,
  STANDARD_SURFACE_FIELDS,
  ORPHAN_SURFACES,
} from "@/lib/customer-form/surface-mapping";

// Kate's 2026-07-09 color/finish writeback spec. These tests pin the exact
// SF-field routing + finish picklist normalization the customer-form submit
// route relies on — the write target is Salesforce (source of truth), so a
// silent regression here paints rooms the wrong sheen.

describe("normalizeFinishToSf (§3 finish value map)", () => {
  it("maps identity finishes to their SF picklist value", () => {
    expect(normalizeFinishToSf("Eggshell")).toBe("Eggshell");
    expect(normalizeFinishToSf("Satin")).toBe("Satin");
    expect(normalizeFinishToSf("Flat")).toBe("Flat");
    expect(normalizeFinishToSf("Matte")).toBe("Matte");
    expect(normalizeFinishToSf("Gloss")).toBe("Gloss");
  });

  it("normalizes Semi-Gloss to the one-word SF value 'Semigloss'", () => {
    expect(normalizeFinishToSf("Semi-Gloss")).toBe("Semigloss");
  });

  it("returns null for High-Gloss (no SF picklist value — never guess)", () => {
    expect(normalizeFinishToSf("High-Gloss")).toBeNull();
  });

  it("returns null for legacy combined labels", () => {
    expect(normalizeFinishToSf("Flat / Matte")).toBeNull();
    expect(normalizeFinishToSf("Gloss / High-Gloss")).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeFinishToSf("  semi-gloss ")).toBe("Semigloss");
    expect(normalizeFinishToSf("EGGSHELL")).toBe("Eggshell");
  });

  it("returns null for empty / missing / unknown input", () => {
    expect(normalizeFinishToSf(null)).toBeNull();
    expect(normalizeFinishToSf(undefined)).toBeNull();
    expect(normalizeFinishToSf("")).toBeNull();
    expect(normalizeFinishToSf("Chalkboard")).toBeNull();
  });
});

describe("classifySurface (§1 surface routing)", () => {
  it("routes each standard surface to its dedicated color+finish fields", () => {
    expect(classifySurface("Walls")).toEqual({
      kind: "standard",
      color: "ColorWall__c",
      finish: "FinishWall__c",
    });
    expect(classifySurface("Ceiling")).toEqual({
      kind: "standard",
      color: "ColorCeiling__c",
      finish: "FinishCeiling__c",
    });
    expect(classifySurface("Trim")).toEqual({
      kind: "standard",
      color: "ColorTrim__c",
      finish: "FinishTrim__c",
    });
    expect(classifySurface("Floor")).toEqual({
      kind: "standard",
      color: "ColorFloor__c",
      finish: "FinishFloor__c",
    });
  });

  it("treats the singular 'Wall' the same as 'Walls'", () => {
    expect(classifySurface("Wall")).toMatchObject({ color: "ColorWall__c" });
  });

  it("classifies every orphan surface from the spec as an orphan", () => {
    for (const s of ["Cabinets", "Accent Wall", "Door", "Window", "Closet", "Shelves"]) {
      expect(classifySurface(s)).toEqual({ kind: "orphan" });
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifySurface("  ACCENT WALL ")).toEqual({ kind: "orphan" });
    expect(classifySurface("wALLs")).toMatchObject({ kind: "standard" });
  });

  it("returns 'unknown' for a label that is neither standard nor orphan", () => {
    expect(classifySurface("Soffit")).toEqual({ kind: "unknown" });
  });

  it("keeps standard + orphan surface sets disjoint", () => {
    for (const key of Object.keys(STANDARD_SURFACE_FIELDS)) {
      expect(ORPHAN_SURFACES.has(key)).toBe(false);
    }
  });
});
