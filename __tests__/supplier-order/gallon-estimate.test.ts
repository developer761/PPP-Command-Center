import { describe, it, expect } from "vitest";
import {
  estimateOrderGallons,
  packageGallons,
  formatOrderQuantity,
  COVERAGE_CONFIG,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * The gallon calculator had NO test coverage. Not one file imported
 * estimateOrderGallons or packageGallons, so on 2026-09-08 the coat multiplier
 * and the rounding direction — the two numbers that decide how much paint PPP
 * buys on every job — were both changed and 2434 tests stayed green.
 *
 * These pin the numbers Karan gave from the trade:
 *   "a 15x20x8 living room is 2 cans, an 8x10x8 is 2 max"
 *   "do 1.75 coats and round down, everything else stays the same"
 *
 * Asserted as ORDERS, not intermediate areas — the order is what gets bought.
 */

const surf = (kind: RoomTakeoff["surfaces"][number]["kind"], label: string, colorId: string, colorName: string) =>
  ({ kind, surfaceLabel: label, colorId, colorName, colorCode: null, finish: null });

/** A room with real geometry and the three usual surfaces, each its own colour. */
function room(w: number, l: number, h: number, over: Partial<RoomTakeoff> = {}): RoomTakeoff {
  return {
    woliId: "woli-1",
    roomLabel: `${w}x${l}`,
    floorAreaSqft: w * l,
    wallSurfaceAreaSqft: 0,
    perimeterLf: 2 * (w + l),
    heightFt: h,
    doors: 0, windows: 0, closets: 0,
    coats: 0,
    paintDoorFaces: false,
    surfaces: [
      surf("walls", "Walls", "wall", "Wall colour"),
      surf("ceiling", "Ceiling", "ceil", "Ceiling white"),
      surf("trim", "Trim", "trim", "Trim white"),
    ],
    ...over,
  };
}

const byColor = (rooms: RoomTakeoff[]) =>
  Object.fromEntries(estimateOrderGallons(rooms).map((e) => [e.colorId, e]));

describe("what PPP actually orders", () => {
  it("8x10x8 bedroom — 1 gallon of wall paint, nothing else", () => {
    const e = byColor([room(8, 10, 8)]);
    expect(e.wall.gallons).toBe(1);
    // Under a gallon each: the crew carries these.
    expect(e.ceil.gallons).toBe(0);
    expect(e.trim.gallons).toBe(0);
    const total = Object.values(e).reduce((n, x) => n + x.gallons, 0);
    expect(total, "Karan: 2 gallons max for this room").toBeLessThanOrEqual(2);
  });

  it("15x20x8 living room — 2 wall + 1 ceiling", () => {
    const e = byColor([room(15, 20, 8)]);
    expect(e.wall.gallons).toBe(2);
    expect(e.ceil.gallons).toBe(1);
    expect(e.trim.gallons).toBe(0);
  });

  it("a big room still rolls into a 5-gallon bucket", () => {
    // The bucket threshold must survive the rounding change: >4 gal buys a pail.
    const e = byColor([room(30, 40, 10)]);
    expect(e.wall.buckets).toBeGreaterThanOrEqual(1);
  });
});

describe("the two constants that decide the order", () => {
  it("assumes 1.75 coats, not 2", () => {
    expect(COVERAGE_CONFIG.defaultCoats).toBe(1.75);
  });

  it("an explicit coat count from Salesforce still wins", () => {
    // 1.75 is what we assume when SF is silent. A measured 3 is data.
    const a = byColor([room(15, 20, 8)]).wall.totalSqft;
    const b = byColor([room(15, 20, 8, { coats: 3 })]).wall.totalSqft;
    expect(b).toBeGreaterThan(a);
    expect(b / a).toBeCloseTo(3 / 1.75, 2);
  });

  it("rounds DOWN", () => {
    expect(packageGallons(2.9)).toEqual({ buckets: 0, cans: 2 });
    expect(packageGallons(1.99)).toEqual({ buckets: 0, cans: 1 });
    expect(packageGallons(0.9)).toEqual({ buckets: 0, cans: 0 });
    // and exact values are untouched
    expect(packageGallons(3)).toEqual({ buckets: 0, cans: 3 });
  });
});

describe("a line that rounds to nothing says why", () => {
  it("flags sizedToZero rather than rendering a bare dash", () => {
    const e = byColor([room(8, 10, 8)]);
    expect(e.trim.sizedToZero).toBe(true);
    expect(formatOrderQuantity(e.trim)).toBe("under 1 gal — from stock");
  });

  it("does not confuse it with a room that has no measurements", () => {
    // No data at all is a different problem with a different fix — re-measure,
    // not "take it off the truck".
    const blank = room(8, 10, 8, { floorAreaSqft: 0, perimeterLf: 0, wallSurfaceAreaSqft: 0 });
    const e = byColor([blank]);
    expect(e.wall.sizedToZero).toBe(false);
    expect(formatOrderQuantity(e.wall)).not.toBe("under 1 gal — from stock");
  });

  it("a real order is not flagged", () => {
    const e = byColor([room(15, 20, 8)]);
    expect(e.wall.sizedToZero).toBe(false);
  });
});
