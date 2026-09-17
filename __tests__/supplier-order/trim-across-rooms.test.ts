import { describe, it, expect } from "vitest";
import {
  estimateOrderGallons,
  formatOrderQuantity,
  COVERAGE_CONFIG,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * Jason + Alex, 2026-09-17: "Trim paint at the same color in multiple rooms
 * should not remain at just 1 qt ordered — it should calculate linear feet
 * total within the rooms, add 25% for door and window molding. usually when
 * the trim is the same color through multiple rooms, 2+ is 1 gallon of trim
 * paint."
 *
 * The old model priced trim as a 3-inch-wide painted strip: geometrically
 * honest, and it answered "1 qt" for a whole floor of trim because it costs
 * none of the brush work. Trim is now sized from linear feet at a usage rate.
 *
 * Karan's trade figures from 2026-09-08 still hold at the bottom end — ONE
 * ordinary room's trim is not a gallon — so both are asserted here, in one
 * file, because the two rules are only correct together.
 */

const trim = (colorId = "trim-white") => ({
  kind: "trim" as const,
  surfaceLabel: "Trim",
  colorId,
  colorName: "Decorator White",
  colorCode: "CC-20",
  finish: "Semi-Gloss",
});

function room(label: string, w: number, l: number, over: Partial<RoomTakeoff> = {}): RoomTakeoff {
  return {
    woliId: `woli-${label}`,
    roomLabel: label,
    floorAreaSqft: w * l,
    wallSurfaceAreaSqft: 0,
    perimeterLf: 2 * (w + l),
    heightFt: 8,
    doors: 0, windows: 0, closets: 0,
    coats: 0,
    paintDoorFaces: false,
    surfaces: [trim()],
    ...over,
  };
}

describe("trim in more than one room", () => {
  it("two ordinary bedrooms in one trim color is a gallon, not a quart", () => {
    const [e] = estimateOrderGallons([room("Bedroom 1", 10, 12), room("Bedroom 2", 11, 13)]);
    expect(formatOrderQuantity(e)).toBe("1 gal");
  });

  it("two SMALL rooms still reach a gallon", () => {
    // 8x10 and 7x9: 34 + 32 lin ft, +25% = 82 — under the rate on its own, so
    // this is the floor Jason described doing the work rather than the rate.
    const [e] = estimateOrderGallons([room("Hall", 8, 10), room("Closet room", 7, 9)]);
    expect(e.cans).toBe(1);
    expect(e.unit ?? "gal").toBe("gal");
    expect(e.defaultedNote ?? "").toMatch(/2 rooms/);
  });

  it("five rooms is more than one gallon — the floor is a floor, not a cap", () => {
    const rooms = ["A", "B", "C", "D", "E"].map((n) => room(n, 12, 14));
    const [e] = estimateOrderGallons(rooms);
    expect(e.gallons).toBeGreaterThan(1);
  });

  it("ONE room's trim is still priced in quarts", () => {
    // Karan, 2026-09-08: a 15x20 living room's trim is a quart, not a gallon.
    const [e] = estimateOrderGallons([room("Living Room", 15, 20)]);
    expect(e.unit).toBe("qt");
  });

  it("two rooms in DIFFERENT trim colors are two lines, each priced alone", () => {
    const out = estimateOrderGallons([
      room("Bedroom", 10, 12, { surfaces: [trim("white")] }),
      room("Study", 10, 12, { surfaces: [trim("black")] }),
    ]);
    expect(out).toHaveLength(2);
    for (const e of out) expect(e.unit).toBe("qt");
  });
});

describe("the 25% molding uplift", () => {
  it("is applied to the room's linear feet", () => {
    // A room with a 44 ft perimeter carries 55 ft of trim, not 44.
    const cfg = { ...COVERAGE_CONFIG, trimMoldingUpliftPct: 0 as unknown as typeof COVERAGE_CONFIG.trimMoldingUpliftPct };
    const withUplift = estimateOrderGallons([room("Bedroom", 10, 12)])[0].totalSqft;
    const without = estimateOrderGallons([room("Bedroom", 10, 12)], cfg)[0].totalSqft;
    expect(withUplift / without).toBeCloseTo(1.25, 2);
  });

  it("replaces the per-opening casing guesses", () => {
    // The old model added 17 lf per door and 15 per window, and when Salesforce
    // was silent — which is most lines — it invented one of each. Door and
    // window counts no longer move the trim total at all.
    const plain = estimateOrderGallons([room("Bedroom", 10, 12)])[0].totalSqft;
    const many = estimateOrderGallons([room("Bedroom", 10, 12, { doors: 4, windows: 6 })])[0].totalSqft;
    expect(many).toBe(plain);
  });

  it("a measured coat count still costs more paint", () => {
    const base = estimateOrderGallons([room("Bedroom", 10, 12)])[0].totalSqft;
    const three = estimateOrderGallons([room("Bedroom", 10, 12, { coats: 3 })])[0].totalSqft;
    // Precision 1: the reported area is rounded to whole sq ft, so the ratio
    // lands a few thousandths off exact.
    expect(three / base).toBeCloseTo(3 / COVERAGE_CONFIG.defaultCoats, 1);
  });

  it("door FACES are still extra when they are in scope", () => {
    const withFaces = estimateOrderGallons([room("Bedroom", 10, 12, { doors: 2, paintDoorFaces: true })])[0].totalSqft;
    const without = estimateOrderGallons([room("Bedroom", 10, 12, { doors: 2 })])[0].totalSqft;
    expect(withFaces).toBeGreaterThan(without);
  });
});
