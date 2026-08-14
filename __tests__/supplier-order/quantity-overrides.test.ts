import { describe, it, expect } from "vitest";
import {
  applyQuantityOverrides,
  packageForUnit,
  overrideTotal,
  quantityKey,
  formatOrderQuantity,
  formatOrderTotal,
  formatBucketsCans,
  summarizeOrder,
  type GallonEstimate,
} from "@/lib/supplier-order/estimate-gallons";
import { normalizeBuildPayload } from "@/lib/supplier-order/build-state";

/**
 * Kate round-3 #22 / #26 / #27.
 *
 * The bug these guard against: the order screen folded the worker's typed
 * quantities into the TOTAL but not into the per-line rows, so a line could
 * read "manual entry required" while the total climbed with every click. The
 * fix is that exactly one function folds overrides in, and everything —
 * rows, total, vendor email — reads its output.
 */

function estimate(over: Partial<GallonEstimate> = {}): GallonEstimate {
  return {
    colorId: "c1",
    colorName: "Bistro Blue",
    colorCode: "2108-50",
    finish: "Eggshell",
    surfaces: ["Walls"],
    rooms: ["Living Room"],
    totalSqft: 0,
    buckets: 0,
    cans: 0,
    gallons: 0,
    needsMeasurement: true,
    unsized: false,
    manualOnly: true,
    ...over,
  };
}

describe("applyQuantityOverrides", () => {
  it("resolves a manual-only line once a quantity is typed (#26)", () => {
    const [out] = applyQuantityOverrides(
      [estimate()],
      new Map([[quantityKey("c1", "Eggshell"), { buckets: 0, cans: 1, unit: "gal" as const }]])
    );
    expect(out.manualOnly).toBe(false);
    expect(out.cans).toBe(1);
    // The row and the total now agree — this is the exact contradiction Kate saw.
    expect(formatOrderQuantity(out)).toBe("1 gal");
    expect(summarizeOrder([out]).cans).toBe(1);
  });

  it("leaves lines without an override untouched", () => {
    const [out] = applyQuantityOverrides([estimate()], new Map());
    expect(out.manualOnly).toBe(true);
    expect(formatOrderQuantity(out)).toBe("manual entry required");
  });

  it("keys by colour AND finish so two finishes of one colour stay separate", () => {
    const egg = estimate({ finish: "Eggshell" });
    const semi = estimate({ finish: "Semi-Gloss" });
    const out = applyQuantityOverrides(
      [egg, semi],
      new Map([[quantityKey("c1", "Eggshell"), { buckets: 0, cans: 3, unit: "gal" as const }]])
    );
    expect(out[0].cans).toBe(3);
    expect(out[1].manualOnly).toBe(true);
  });

  it("is a no-op when there are no overrides at all", () => {
    const input = [estimate()];
    expect(applyQuantityOverrides(input, undefined)).toBe(input);
  });
});

describe("units (#27)", () => {
  it("packages gallons into 5-gal buckets", () => {
    expect(packageForUnit(12, "gal")).toEqual({ buckets: 2, cans: 2, unit: "gal" });
  });

  it("keeps quarts loose — there is no 5-quart bucket", () => {
    expect(packageForUnit(12, "qt")).toEqual({ buckets: 0, cans: 12, unit: "qt" });
  });

  it("round-trips a container count through its own unit", () => {
    for (const unit of ["gal", "qt"] as const) {
      for (const n of [0, 1, 4, 5, 7, 23]) {
        expect(overrideTotal(packageForUnit(n, unit))).toBe(n);
      }
    }
  });

  it("renders quarts distinctly from gallons", () => {
    expect(formatBucketsCans(0, 3, "qt")).toBe("3 qt");
    expect(formatBucketsCans(1, 2, "gal")).toBe("1 bucket (×5 gal) + 2 gal");
  });

  it("totals gallons and quarts separately rather than adding them", () => {
    const gal = applyQuantityOverrides(
      [estimate({ colorId: "g" })],
      new Map([[quantityKey("g", "Eggshell"), { buckets: 1, cans: 2, unit: "gal" as const }]])
    )[0];
    const qt = applyQuantityOverrides(
      [estimate({ colorId: "q" })],
      new Map([[quantityKey("q", "Eggshell"), { buckets: 0, cans: 4, unit: "qt" as const }]])
    )[0];
    const t = summarizeOrder([gal, qt]);
    expect(t).toMatchObject({ buckets: 1, cans: 2, quarts: 4 });
    expect(formatOrderTotal(t)).toBe("1 bucket (×5 gal) + 2 gal · 4 qt");
  });
});

describe("normalizeBuildPayload (#18)", () => {
  it("returns an empty payload for junk", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      const p = normalizeBuildPayload(junk);
      expect(p.quantities).toEqual({});
      expect(p.extras).toEqual([]);
      expect(p.customColorItems).toEqual([]);
    }
  });

  it("loads a payload written before customColorItems existed", () => {
    const p = normalizeBuildPayload({ mainMaterialType: "Regal Select Eggshell", quantities: {} });
    expect(p.mainMaterialType).toBe("Regal Select Eggshell");
    expect(p.customColorItems).toEqual([]);
  });

  it("clamps quantities and defaults a missing unit to gallons", () => {
    const p = normalizeBuildPayload({ quantities: { k: { buckets: 1e6, cans: -5 } } });
    expect(p.quantities.k).toEqual({ buckets: 99, cans: 0, unit: "gal" });
  });

  it("rejects an unknown unit rather than passing it through", () => {
    const p = normalizeBuildPayload({ quantities: { k: { buckets: 0, cans: 2, unit: "barrel" } } });
    expect(p.quantities.k.unit).toBe("gal");
  });

  it("drops extras and colour items with no name", () => {
    const p = normalizeBuildPayload({
      extras: [{ extraId: "e1", name: "  ", unit: "each", qty: 1 }, { extraId: "", name: "Tape", unit: "each", qty: 1 }],
      customColorItems: [{ id: "c", label: "   ", qty: 1, unit: "gal" }],
    });
    expect(p.extras).toEqual([]);
    expect(p.customColorItems).toEqual([]);
  });

  it("keeps a valid custom colour item and clamps its quantity", () => {
    const p = normalizeBuildPayload({
      customColorItems: [{ id: "c1", label: "Color Match: Behr 56, eggshell", qty: 0, unit: "qt" }],
    });
    expect(p.customColorItems).toEqual([
      { id: "c1", label: "Color Match: Behr 56, eggshell", qty: 1, unit: "qt" },
    ]);
  });
});
