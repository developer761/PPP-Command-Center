import { describe, it, expect } from "vitest";
import {
  isValidCoverageValue,
  mergeCoverageConfig,
  STRICT_POSITIVE_KEYS,
  MAX_COVERAGE_VALUES,
} from "@/lib/supplier-order/coverage-validation";
import { COVERAGE_CONFIG, estimateOrderGallons, type RoomTakeoff } from "@/lib/supplier-order/estimate-gallons";

/**
 * This module had NO test file at all (found by mutation testing, 2026-09-17:
 * disabling either guard left the whole suite green).
 *
 * It is the only thing between a value an admin types into Settings → Coverage
 * and every gallon PPP buys. A 0 for `coverageSqftPerGallon` is a divide by
 * zero on every line; a 1000 for `bufferPct` is an eleven-fold order. Both
 * arrive over an HTTP route.
 */

const room = (): RoomTakeoff => ({
  woliId: "w", roomLabel: "Living Room",
  floorAreaSqft: 300, wallSurfaceAreaSqft: 0, perimeterLf: 70, heightFt: 8,
  doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
  surfaces: [{ kind: "walls", surfaceLabel: "Walls", colorId: "c", colorName: "W", colorCode: null, finish: null }],
});

describe("values that would break every order", () => {
  it("refuses zero where zero divides or means no paint", () => {
    for (const key of STRICT_POSITIVE_KEYS) {
      expect(isValidCoverageValue(key, 0), key).toBe(false);
      expect(isValidCoverageValue(key, -1), key).toBe(false);
    }
    // The four that must be positive, named so a reader can check the list
    // rather than trust it.
    expect(STRICT_POSITIVE_KEYS.has("coverageSqftPerGallon")).toBe(true);
    expect(STRICT_POSITIVE_KEYS.has("defaultCoats")).toBe(true);
    expect(STRICT_POSITIVE_KEYS.has("trimLfPerGallon")).toBe(true);
    expect(STRICT_POSITIVE_KEYS.has("maxGallonsPerLine")).toBe(true);
  });

  it("allows zero where zero is a real answer", () => {
    // No buffer, no default openings, no closets: all legitimate settings.
    expect(isValidCoverageValue("bufferPct", 0)).toBe(true);
    expect(isValidCoverageValue("defaultDoorsPerRoom", 0)).toBe(true);
    expect(isValidCoverageValue("deductWindowSqft", 0)).toBe(true);
  });

  it("refuses the typo that would order eleven times the paint", () => {
    expect(isValidCoverageValue("bufferPct", 10)).toBe(false);
    expect(isValidCoverageValue("bufferPct", MAX_COVERAGE_VALUES.bufferPct)).toBe(true);
    expect(isValidCoverageValue("coverageSqftPerGallon", 10_000)).toBe(false);
    expect(isValidCoverageValue("defaultCoats", 99)).toBe(false);
  });

  it("refuses anything that is not a finite number", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(isValidCoverageValue("bufferPct", v)).toBe(false);
    }
  });
});

describe("merging an admin override over the code defaults", () => {
  it("takes the valid values and ignores the rest", () => {
    const merged = mergeCoverageConfig({
      coverageSqftPerGallon: 350,
      bufferPct: 999,            // insane — must not land
      defaultCoats: 0,           // would mean no paint at all
      notAKey: 5,                // unknown — must not land
    });
    expect(merged.coverageSqftPerGallon).toBe(350);
    expect(merged.bufferPct).toBe(COVERAGE_CONFIG.bufferPct);
    expect(merged.defaultCoats).toBe(COVERAGE_CONFIG.defaultCoats);
    expect((merged as Record<string, unknown>).notAKey).toBeUndefined();
  });

  it("an empty override changes nothing", () => {
    expect(mergeCoverageConfig({})).toEqual(COVERAGE_CONFIG);
  });

  it("and the merged config still produces a sane order", () => {
    // The point of the guards: whatever survives them can be handed to the
    // estimator without it dividing by zero or ordering a pallet.
    const merged = mergeCoverageConfig({ coverageSqftPerGallon: 0, defaultCoats: 0 });
    const [e] = estimateOrderGallons([room()], merged);
    expect(Number.isFinite(e.cans)).toBe(true);
    expect(e.cans).toBeGreaterThan(0);
    expect(e.cans).toBeLessThanOrEqual(COVERAGE_CONFIG.maxGallonsPerLine);
  });
});

/* ── the note that must survive ──────────────────────────────────────────── */

describe("a capped line always says so", () => {
  const room = (label: string, kind: "walls" | "ceiling", over: Partial<RoomTakeoff> = {}): RoomTakeoff => ({
    woliId: `w-${label}`, roomLabel: label,
    floorAreaSqft: 200, wallSurfaceAreaSqft: 0, perimeterLf: 60, heightFt: 8,
    doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [{ kind, surfaceLabel: kind === "walls" ? "Walls" : "Ceiling", colorId: "c", colorName: "W", colorCode: null, finish: null }],
    ...over,
  });

  // The rep's stray keystroke, on the field each surface actually reads.
  const GARBAGE = 9_999_999;

  it("even when a kitchen shares the color", () => {
    // Kitchen WALLS are what `kitchenSharedSqft` counts (a kitchen ceiling is
    // an ordinary ceiling), so this is the shape that reaches the branch —
    // the first version of this test used ceilings and passed with the fix
    // reverted, having exercised nothing.
    const out = estimateOrderGallons([
      room("Kitchen", "walls", { wallSurfaceAreaSqft: GARBAGE }),
      room("Dining Room", "walls", { wallSurfaceAreaSqft: GARBAGE }),
    ]);
    const e = out.find((x) => x.colorId === "c")!;
    expect(e.cans).toBe(COVERAGE_CONFIG.maxGallonsPerLine);
    // The kitchen note here only EXPLAINS the number; the cap says the number
    // is wrong. 99 gal once shipped under "counted at half for the cabinets".
    expect(e.defaultedNote ?? "").toMatch(/Capped at/);
  });

  it("and that same pair says 'counted at half' when the numbers are sane", () => {
    // Proof the branch is reached at all — without this, the assertion above
    // could be passing because the kitchen note never fires in this shape.
    const out = estimateOrderGallons([room("Kitchen", "walls"), room("Dining Room", "walls")]);
    const e = out.find((x) => x.colorId === "c")!;
    expect(e.defaultedNote ?? "").toMatch(/counted at half/);
    expect(e.cans).toBeLessThan(COVERAGE_CONFIG.maxGallonsPerLine);
  });

  it("but a kitchen on its own color is 1 gal, and says why — not 'capped'", () => {
    // Here the rule REPLACED the number, so the cap no longer describes what
    // is being bought and "capped at 99" would be a lie.
    const [e] = estimateOrderGallons([room("Kitchen", "walls", { wallSurfaceAreaSqft: GARBAGE })]);
    expect(e.cans).toBe(COVERAGE_CONFIG.kitchenDefaultGallons);
    expect(e.defaultedNote ?? "").not.toMatch(/Capped at/);
    expect(e.defaultedNote ?? "").toMatch(/cabinets/);
  });
});
