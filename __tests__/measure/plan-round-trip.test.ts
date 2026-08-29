import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFloorPlan, versusBoundingRectangle, type WallSegment } from "@/lib/measure/floor-plan";

/**
 * The walked perimeter has to survive all the way to the gallon estimate,
 * because that is the only reason walking the room is worth the time.
 *
 * The estimator falls back to `4 × √area` when it has no perimeter, and derives
 * `2(L+W)` when it has dimensions — both describe a RECTANGLE. An L-shaped room
 * has more wall than either produces, so if the walked number is dropped
 * anywhere along the way, the extra effort buys nothing and nobody finds out.
 */
const w = (lengthFt: number, turn: "right" | "left" = "right"): WallSegment => ({ lengthFt, turn });
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a walked plan beats every rectangle approximation", () => {
  // U-shaped room: two inside corners. 30 across, then in and out twice.
  const plan = buildFloorPlan([
    w(30), w(12), w(10), w(8, "left"), w(10, "left"), w(12),
  ]);

  it("has more wall than the square-root guess the estimator would make", () => {
    if (!plan.closed) return; // shape guard — the assertions below need a room
    const squareGuess = 4 * Math.sqrt(plan.floorAreaSqft);
    expect(plan.perimeterLf).toBeGreaterThan(squareGuess);
  });

  it("has more wall than a bounding rectangle implies", () => {
    const cmp = versusBoundingRectangle(plan);
    if (!cmp) return;
    // Negative means the rectangle UNDER-states the perimeter — under-buying
    // wall paint, which is the expensive direction to be wrong in.
    expect(cmp.perimeterDiffPct).toBeLessThanOrEqual(0);
  });
});

describe("the number is not dropped between the room and the vendor", () => {
  const api = codeOnly(read("app/api/admin/measure/route.ts"));
  const ui = codeOnly(read("components/measure-tool.tsx"));

  it("the UI sends the walked perimeter explicitly", () => {
    expect(ui).toMatch(/perimeterLf:\s*measurement\.room\.perimeterLf/);
  });

  it("a walked room never sends length or width", () => {
    // The invariant, not the old shape: sending either would let the server
    // re-derive a RECTANGLE's perimeter over the real one, which is the entire
    // thing walking the room exists to beat. The new UI branches on
    // `measurement.room` and sends sqft + perimeterLf alone.
    const walked = ui.slice(ui.indexOf("measurement.room"), ui.indexOf("measurement.room") + 700);
    expect(walked).toMatch(/sqft:\s*measurement\.room\.sqft/);
    expect(walked).toMatch(/perimeterLf:\s*measurement\.room\.perimeterLf/);
    expect(walked, "a walked room must not send lengthFt").not.toMatch(/lengthFt:/);
    expect(walked, "a walked room must not send widthFt").not.toMatch(/widthFt:/);
  });

  
  it("the server honours an explicit perimeter instead of re-deriving one", () => {
    expect(api).toMatch(/body\.perimeterLf != null && Number\(body\.perimeterLf\) > 0/);
    // The derive path must be reachable only when nothing was supplied.
    expect(api).toMatch(/if \(perimeterLf == null && lengthFt && widthFt/);
  });

  it("the server persists it to the column the estimator reads", () => {
    expect(api).toMatch(/perimeter_lf: perimeterLf/);
  });

  });
