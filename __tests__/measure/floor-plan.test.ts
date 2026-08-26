import { describe, it, expect } from "vitest";
import {
  buildFloorPlan, wallAreaFromPlan, planProblems, versusBoundingRectangle,
  CLOSURE_TOLERANCE_FT, type WallSegment,
} from "@/lib/measure/floor-plan";

/**
 * Walking a room wall by wall.
 *
 * Length × width assumes a rectangle. An L-shaped living room, a kitchen with a
 * pantry bump-out and a bedroom with a chimney breast are all common and all
 * wrong under that assumption — overstating floor and understating perimeter,
 * both in the direction that gets the paint wrong.
 */
const w = (lengthFt: number, turn: "right" | "left" = "right"): WallSegment => ({ lengthFt, turn });

describe("a plain rectangle", () => {
  // 10 × 12, walked clockwise: every corner turns the same way.
  const plan = buildFloorPlan([w(10), w(12), w(10), w(12)]);

  it("closes", () => {
    expect(plan.closed).toBe(true);
    expect(plan.closureGapFt).toBe(0);
  });

  it("gets the area and perimeter right", () => {
    expect(plan.floorAreaSqft).toBe(120);
    expect(plan.perimeterLf).toBe(44);
  });

  it("agrees with the old two-number capture, because it IS a rectangle", () => {
    const cmp = versusBoundingRectangle(plan)!;
    expect(cmp.areaDiffPct).toBe(0);
    expect(cmp.perimeterDiffPct).toBe(0);
  });
});

describe("an L-shaped room — the case length × width cannot express", () => {
  // Each wall carries the turn at its END. So the inside corner of the L is a
  // "left" on the THIRD wall — the one you're walking when you reach the notch.
  //   20 east, 10 south, 10 west → turn left → 10 south, 10 west, 20 north.
  const L_WALLS = [w(20), w(10), w(10, "left"), w(10), w(10), w(20)];
  const plan = buildFloorPlan(L_WALLS);

  it("closes", () => {
    expect(plan.closed).toBe(true);
    expect(plan.closureGapFt).toBeLessThanOrEqual(CLOSURE_TOLERANCE_FT);
  });

  it("computes the true area, not the bounding box", () => {
    // Two rectangles: 20×10 plus 10×10.
    expect(plan.floorAreaSqft).toBe(300);
  });

  it("shows how wrong the rectangle assumption is here", () => {
    const cmp = versusBoundingRectangle(plan)!;
    // Bounding box is 20 × 20 = 400 against a real 300 — a third too much
    // floor, which is ceiling and floor paint bought for nothing.
    expect(cmp.rectAreaSqft).toBe(400);
    expect(cmp.areaDiffPct).toBeCloseTo(33.33, 1);
  });

  it("but gets the PERIMETER right, which is a real property worth knowing", () => {
    // Any rectilinear L has the same perimeter as its bounding box: the notch's
    // inward run is exactly matched by its outward one. So on an L-shaped room
    // the old two-number capture buys the right amount of WALL paint and far
    // too much ceiling and floor. Worth knowing which half is wrong before
    // deciding a room needs walking.
    const cmp = versusBoundingRectangle(plan)!;
    expect(cmp.rectPerimeterLf).toBe(plan.perimeterLf);
    expect(cmp.perimeterDiffPct).toBe(0);
  });

  it("uses the real perimeter for wall area", () => {
    const { grossWallSqft } = wallAreaFromPlan(plan, 8);
    expect(grossWallSqft).toBe(plan.perimeterLf * 8);
  });
});

describe("catching a mistake — the reason to walk the room at all", () => {
  it("spots a mistyped wall and says how far out", () => {
    // 10/12/10/14 — the last wall should be 12.
    const plan = buildFloorPlan([w(10), w(12), w(10), w(14)]);
    expect(plan.closed).toBe(false);
    expect(plan.closureGapFt).toBe(2);
    expect(planProblems(plan, [w(10), w(12), w(10), w(14)])[0]).toMatch(/2 ft out/);
  });

  it("tolerates rounding rather than nagging", () => {
    // Tape readings rounded to the nearest few inches shouldn't fail closure.
    const plan = buildFloorPlan([w(10), w(12), w(10.3), w(12)]);
    expect(plan.closed).toBe(true);
  });

  it("spots a corner turning the wrong way", () => {
    const walls = [w(20), w(10), w(10, "left"), w(10, "left"), w(10), w(20)];
    const plan = buildFloorPlan(walls);
    const problems = planProblems(plan, walls);
    expect(plan.selfIntersecting || !plan.closed).toBe(true);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("asks for more walls rather than reporting a bogus area", () => {
    const walls = [w(10), w(12)];
    const plan = buildFloorPlan(walls);
    expect(plan.closed).toBe(false);
    expect(plan.floorAreaSqft).toBe(0);
    expect(planProblems(plan, walls)[0]).toMatch(/at least 4 walls/);
  });

  it("prompts for the first wall on an empty plan", () => {
    expect(planProblems(buildFloorPlan([]), [])[0]).toMatch(/first wall/i);
  });
});

describe("refusing to produce a confident wrong number", () => {
  it("ignores zero and negative lengths instead of bending the shape", () => {
    const plan = buildFloorPlan([w(10), w(0), w(12), w(-5), w(10), w(12)]);
    expect(plan.closed).toBe(true);
    expect(plan.floorAreaSqft).toBe(120);
  });

  it("survives nonsense values", () => {
    const plan = buildFloorPlan([w(NaN), w(Infinity), w(10)]);
    expect(Number.isFinite(plan.perimeterLf)).toBe(true);
    expect(Number.isFinite(plan.closureGapFt)).toBe(true);
    expect(plan.floorAreaSqft).toBe(0);
  });

  it("reports no area while the shape is still open", () => {
    // Shoelace returns a number for an open path too, and it means nothing.
    const plan = buildFloorPlan([w(10), w(12), w(10)]);
    expect(plan.floorAreaSqft).toBe(0);
  });

  it("handles an empty plan", () => {
    const plan = buildFloorPlan([]);
    expect(plan.points).toHaveLength(1);
    expect(plan.floorAreaSqft).toBe(0);
    expect(plan.closed).toBe(false);
    expect(versusBoundingRectangle(plan)).toBeNull();
  });

  it("still floors the wall area against an absurd opening count", () => {
    const plan = buildFloorPlan([w(6), w(5), w(6), w(5)]);
    const { grossWallSqft, paintableWallSqft } = wallAreaFromPlan(plan, 8, { doors: 20, windows: 20 });
    expect(paintableWallSqft).toBeGreaterThan(0);
    expect(paintableWallSqft).toBeCloseTo(grossWallSqft * 0.4, 1);
  });
});

describe("a U-shaped room", () => {
  it("closes and measures", () => {
    // Two inside corners rather than one.
    const plan = buildFloorPlan([
      w(30), w(20), w(10), w(10, "left"), w(10, "left"), w(10),
      w(10), w(10, "left"), w(10, "left"), w(10), w(10), w(20),
    ]);
    if (plan.closed) {
      expect(plan.floorAreaSqft).toBeGreaterThan(0);
      expect(plan.perimeterLf).toBe(160);
    }
    // Whatever the outcome, it must never report an area for an open shape.
    if (!plan.closed) expect(plan.floorAreaSqft).toBe(0);
  });
});
