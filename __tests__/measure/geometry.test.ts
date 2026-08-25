import { describe, it, expect } from "vitest";
import {
  geometryFromDimensions,
  perimeterGainVsSquareGuess,
  distributeHouseSqft,
  roomWeight,
  DEFAULT_CEILING_FT,
} from "@/lib/measure/geometry";

/**
 * The accuracy argument for capturing two numbers instead of one.
 *
 * The estimator falls back to `4 × √(floor area)` for perimeter, which assumes
 * every room is square. Anyone measuring a room has both numbers in hand, so
 * capturing them costs nothing and removes the assumption.
 */
describe("room geometry from tape measurements", () => {
  it("gets a square room right either way", () => {
    const g = geometryFromDimensions({ lengthFt: 12, widthFt: 12, ceilingFt: 8 });
    expect(g.floorAreaSqft).toBe(144);
    expect(g.perimeterLf).toBe(48);
    const cmp = perimeterGainVsSquareGuess({ lengthFt: 12, widthFt: 12 });
    expect(cmp.pctDifference).toBe(0); // square guess is exactly right here
  });

  it("beats the square guess badly on a long room", () => {
    // Same 144 sqft, completely different walls. A hallway, a galley kitchen
    // and a long living room all live here — and they're common.
    const cmp = perimeterGainVsSquareGuess({ lengthFt: 24, widthFt: 6 });
    expect(cmp.realLf).toBe(60);
    expect(cmp.squareGuessLf).toBe(48);
    expect(cmp.pctDifference).toBe(25); // the square guess is 25% LOW on paint
  });

  it("deducts doors and windows from the paintable wall", () => {
    const g = geometryFromDimensions(
      { lengthFt: 12, widthFt: 10, ceilingFt: 8 },
      { doors: 1, windows: 2 }
    );
    expect(g.grossWallSqft).toBe(352);           // 2*(12+10)=44 lf × 8
    expect(g.paintableWallSqft).toBe(302);       // −20 door −30 windows
  });

  it("refuses to let a typo under-order the paint", () => {
    // "12 doors" in a small room would otherwise drive the wall area to zero
    // and buy nothing. Floor at 40% of gross.
    const g = geometryFromDimensions(
      { lengthFt: 6, widthFt: 5, ceilingFt: 8 },
      { doors: 12, windows: 6 }
    );
    expect(g.paintableWallSqft).toBeGreaterThan(0);
    expect(g.paintableWallSqft).toBe(Math.round(g.grossWallSqft * 0.4 * 10) / 10);
  });

  it("falls back to a standard ceiling when none is given", () => {
    const g = geometryFromDimensions({ lengthFt: 10, widthFt: 10, ceilingFt: 0 });
    expect(g.grossWallSqft).toBe(40 * DEFAULT_CEILING_FT);
  });

  it("returns zeroes rather than NaN on empty input", () => {
    const g = geometryFromDimensions({ lengthFt: 0, widthFt: 0, ceilingFt: 0 });
    expect(g.floorAreaSqft).toBe(0);
    expect(g.perimeterLf).toBe(0);
    expect(Number.isFinite(g.paintableWallSqft)).toBe(true);
  });
});

/**
 * Property records give ONE number for a building and never room dimensions,
 * so this split is deliberately rough — but "rough" should still beat "equal
 * shares", because a master bedroom is not a powder room.
 */
describe("distributing a whole-house square footage", () => {
  const rooms = [
    { id: "a", label: "Living Room" },
    { id: "b", label: "Master Bedroom" },
    { id: "c", label: "Guest Bedroom" },
    { id: "d", label: "Powder Bath" },
  ];

  it("gives bigger rooms more of the house", () => {
    const d = distributeHouseSqft(2000, rooms);
    expect(d.a).toBeGreaterThan(d.b);   // living > master
    expect(d.b).toBeGreaterThan(d.c);   // master > guest
    expect(d.c).toBeGreaterThan(d.d);   // guest  > bath
  });

  it("does not hand out the whole house", () => {
    // Hallways, stairs and closets aren't on the work order but are in the
    // square footage. Distributing 100% would inflate every room.
    const total = Object.values(distributeHouseSqft(2000, rooms)).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(2000);
    expect(total).toBeGreaterThan(1400);
  });

  it("treats an unrecognised room as an average one", () => {
    expect(roomWeight("Bonus Space Over Garage")).toBe(1.0);
    expect(roomWeight("Powder")).toBeLessThan(1.0);
  });

  it("degrades safely", () => {
    expect(distributeHouseSqft(0, rooms)).toEqual({});
    expect(distributeHouseSqft(2000, [])).toEqual({});
  });
});
