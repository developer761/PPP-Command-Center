import { describe, it, expect } from "vitest";
import { geometryFromDimensions, DEFAULT_CEILING_FT } from "@/lib/measure/geometry";
import { buildFloorPlan, wallAreaFromPlan } from "@/lib/measure/floor-plan";

/**
 * A guessed ceiling must never look like a measured one.
 *
 * Both geometry paths fall back to 8 ft when nobody enters a height. That is
 * the right default for residential Long Island — but the wall area it drives
 * becomes a paint quantity, and a real 9 ft ceiling under-orders by 12.5%. The
 * fallback stays; what it must not do is stay silent.
 */
describe("assumed ceiling height is reported, not hidden", () => {
  it("flags the rectangle path when no height was entered", () => {
    const g = geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: 0 });
    expect(g.ceilingAssumed).toBe(true);
    expect(g.grossWallSqft).toBe(44 * DEFAULT_CEILING_FT);
  });

  it("does not flag it when a height was actually measured", () => {
    const g = geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: 9 });
    expect(g.ceilingAssumed).toBe(false);
    expect(g.grossWallSqft).toBe(44 * 9);
  });

  it("flags the walked-plan path the same way", () => {
    const plan = buildFloorPlan([
      { lengthFt: 12, turn: "right" }, { lengthFt: 10, turn: "right" },
      { lengthFt: 12, turn: "right" }, { lengthFt: 10, turn: "right" },
    ]);
    expect(plan.closed).toBe(true);
    expect(plan.floorAreaSqft).toBe(120);

    const guessed = wallAreaFromPlan(plan, 0);
    expect(guessed.ceilingAssumed).toBe(true);
    expect(guessed.grossWallSqft).toBe(44 * 8);

    const measured = wallAreaFromPlan(plan, 9);
    expect(measured.ceilingAssumed).toBe(false);
    expect(measured.grossWallSqft).toBe(44 * 9);
  });

  it("shows the size of the error the flag exists to warn about", () => {
    // If this gap were ever small enough not to matter, the warning could go.
    const assumed = geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: 0 });
    const real = geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: 9 });
    const shortfall = 1 - assumed.paintableWallSqft / real.paintableWallSqft;
    expect(shortfall).toBeGreaterThan(0.1);   // >10% under-order
  });

  it("treats junk and negative heights as absent rather than trusting them", () => {
    expect(geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: -4 }).ceilingAssumed).toBe(true);
    expect(geometryFromDimensions({ lengthFt: 12, widthFt: 10, ceilingFt: NaN }).ceilingAssumed).toBe(true);
    expect(wallAreaFromPlan(buildFloorPlan([
      { lengthFt: 12, turn: "right" }, { lengthFt: 10, turn: "right" },
      { lengthFt: 12, turn: "right" }, { lengthFt: 10, turn: "right" },
    ]), NaN).ceilingAssumed).toBe(true);
  });
});
