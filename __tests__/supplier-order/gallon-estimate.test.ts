import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRoomType,
  isDoorSurface,
  estimateOrderGallons,
  packageGallons,
  packageForUnit,
  formatOrderQuantity,
  formatBucketsCans,
  addCustomItemsToTotal,
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
  it("8x10x8 bedroom — 1 gallon of walls, ceiling and trim in quarts", () => {
    const e = byColor([room(8, 10, 8)]);
    expect(e.wall.cans).toBe(1);
    // Absent unit means gallons — the estimator's existing convention.
    expect(e.wall.unit ?? "gal").toBe("gal");
    // Katie 2026-09-08: under a gallon is priced in QUARTS rather than dropped.
    // It used to order nothing and read "from stock".
    expect(e.ceil.unit).toBe("qt");
    expect(e.ceil.cans).toBe(1);
    expect(e.trim.unit).toBe("qt");
    expect(e.trim.cans).toBe(1);
  });

  it("15x20x8 living room — 2 wall + 1 ceiling, trim a quart", () => {
    const e = byColor([room(15, 20, 8)]);
    expect(e.wall.gallons).toBe(2);
    expect(e.ceil.gallons).toBe(1);
    expect(e.trim.unit).toBe("qt");
  });

  it("a big room stays in gallons — the pail is the estimator's call", () => {
    // Karan 2026-09-09 removed automatic bucketing. Five gallons and a
    // five-gallon pail are not the same purchase: the pail is cheaper per
    // gallon but it is one container, and whether that suits the job is a
    // person's decision. The unit toggle offers Bucket at five and up.
    const e = byColor([room(30, 40, 10)]);
    expect(e.wall.buckets).toBe(0);
    expect(e.wall.cans).toBeGreaterThanOrEqual(5);
  });

  it("packageGallons never buckets on its own", () => {
    expect(packageGallons(12)).toEqual({ buckets: 0, cans: 12 });
    expect(packageGallons(5)).toEqual({ buckets: 0, cans: 5 });
  });

  it("...but packageForUnit still converts when a person picks Bucket", () => {
    // 10 gallons chosen as pails is 2 pails.
    expect(packageForUnit(10, "bucket")).toEqual({ buckets: 0, cans: 2, unit: "bucket" });
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

describe("a line under a gallon is priced in quarts, not dropped", () => {
  it("orders quarts where it used to order nothing", () => {
    // Katie 2026-09-08: "I would also recommend having the option to order 1
    // quart of this paint." Trim at 0.13 gal used to read "from stock" and
    // reach the vendor as no line at all.
    const e = byColor([room(8, 10, 8)]);
    expect(e.trim.sizedToZero).toBe(false);
    expect(formatOrderQuantity(e.trim)).toBe("1 qt");
  });

  it("three quarts becomes a gallon", () => {
    // Katie: "if we're ordering 3qts, the price makes sense to just order 1
    // gallon." Four quarts IS a gallon, so at three the tin is cheaper.
    //
    // A 5x7 hallway computes 0.81 gallons of wall paint — 3.2 quarts, which
    // floors to exactly 3 and is the only size that exercises the threshold.
    // The first version used a 15x20 ceiling, which is 1.54 gallons and never
    // enters the quart path at all: it passed with the threshold set to 99.
    // Labelled Hallway on purpose, so the bathroom rule does not answer first.
    const e = byColor([room(5, 7, 8, { roomLabel: "Hallway" })]);
    expect(e.wall.unit ?? "gal").toBe("gal");
    expect(e.wall.cans).toBe(1);
  });

  it("two quarts stays quarts", () => {
    // The other side of the threshold, or the rule above passes by ordering a
    // gallon for everything under one.
    const e = byColor([room(4, 5, 8, { roomLabel: "Hallway" })]);
    expect(e.wall.unit).toBe("qt");
    expect(e.wall.cans).toBeLessThan(3);
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

/**
 * ROOM-TYPE DEFAULTS (Karan 2026-09-08):
 *   "kitchen or things like that is usually only one gallon because of taking
 *    account cabinets (usually default to one gallon)"
 *   "bathrooms is usually quarts (5x7 bathroom quarts)"
 *   "so things were manually defaulting ... like Kitchen is manually defaulted
 *    to 1 gallon, please review"
 *
 * Both stand in for data we do not have — the cabinet run — so both are FLAGGED
 * rather than applied silently.
 */
describe("room-type defaults", () => {
  const kitchen = (w: number, l: number, colorId = "wall") =>
    room(w, l, 8, { roomLabel: "Kitchen", surfaces: [surf("walls", "Walls", colorId, "Wall colour")] });

  it("a kitchen defaults to one gallon of wall paint, whatever its size", () => {
    for (const [w, l] of [[10, 12], [20, 25], [8, 9]] as const) {
      const e = byColor([kitchen(w, l)]);
      expect(e.wall.gallons, `${w}x${l} kitchen`).toBe(1);
      expect(e.wall.defaultedNote).toMatch(/Kitchen/);
      expect(e.wall.defaultedNote).toMatch(/review/i);
    }
  });

  it("a kitchen ceiling on its own colour is capped too", () => {
    // Karan 2026-09-08: "Kitchen ceiling should also be capped at 1 gallon
    // unless it's folded into all the other ceilings."
    const e = byColor([room(20, 25, 9, { roomLabel: "Kitchen" })]);
    expect(e.ceil.cans).toBe(1);
    expect(e.ceil.unit).toBe("gal");
    expect(e.ceil.defaultedNote).toMatch(/Kitchen/);
  });

  it("bathroom trim is a quart, not a gallon", () => {
    // Katie named walls and ceilings. A catch-all also swept up TRIM and
    // ordered a gallon of it for a few feet of casing — caught by running it.
    const e = byColor([room(5, 7, 8, { roomLabel: "Bathroom" })]);
    expect(e.trim.unit).toBe("qt");
    expect(e.wall.unit).toBe("gal");
  });

  it("a shared kitchen contributes HALF its wall area", () => {
    // Katie 2026-09-08: "if the surface area from dimensions = 300sq ft, then
    // it only adds 150sq ft" — the cabinets are still there when the colour
    // runs on into the dining room.
    const shared = [
      room(10, 12, 8, { roomLabel: "Kitchen", surfaces: [surf("walls", "Walls", "shared", "Shared")] }),
      room(15, 20, 8, { roomLabel: "Living Room", surfaces: [surf("walls", "Walls", "shared", "Shared")] }),
    ];
    const withKitchen = byColor(shared).shared;
    const livingOnly = byColor([shared[1]]).shared;
    const kitchenOnly = byColor([{ ...shared[0], roomLabel: "Kitchen" }]).shared;

    // Halved, so it adds LESS than the kitchen would alone...
    expect(withKitchen.totalSqft - livingOnly.totalSqft).toBeLessThan(kitchenOnly.totalSqft);
    // ...but more than nothing: the kitchen is still being painted.
    expect(withKitchen.totalSqft).toBeGreaterThan(livingOnly.totalSqft);
    expect(withKitchen.defaultedNote).toMatch(/half/i);
  });

  it("bathroom walls are a gallon, the ceiling a quart", () => {
    // Katie 2026-09-08 revised this: the maths gives three quarts for a 5x7,
    // and four quarts IS a gallon, so the tin is cheaper.
    const e = byColor([room(5, 7, 8, { roomLabel: "Bathroom" })]);
    expect(e.wall.unit).toBe("gal");
    expect(e.wall.cans).toBe(1);
    expect(e.ceil.unit).toBe("qt");
    expect(e.ceil.cans).toBe(1);
  });

  it("even a tiny water closet gets paint", () => {
    // A 2x3 computes well under a quart. It must never order nothing.
    const e = byColor([room(2, 3, 8, { roomLabel: "Powder Room" })]);
    expect(e.wall.cans).toBeGreaterThanOrEqual(1);
  });

  it("classifies the labels PPP actually types", () => {
    expect(classifyRoomType("Kitchen")).toBe("kitchen");
    expect(classifyRoomType("Kitchenette")).toBe("kitchen");
    expect(classifyRoomType("Master Bathroom")).toBe("bathroom");
    expect(classifyRoomType("Powder Room")).toBe("bathroom");
    expect(classifyRoomType("Ensuite")).toBe("bathroom");
    expect(classifyRoomType("Living Room")).toBeNull();
    expect(classifyRoomType("")).toBeNull();
    expect(classifyRoomType(null)).toBeNull();
  });
});

/**
 * Katie items 6 and 7.
 */
describe("doors and accent walls", () => {
  const line = (label: string, kind: "walls" | "trim" | "unsized", surfaceLabel: string, colorId: string) =>
    room(15, 20, 8, {
      roomLabel: label,
      surfaces: [surf(kind, surfaceLabel, colorId, colorId)],
    });

  it("a door-only line is a quart", () => {
    const e = byColor([line("Hall", "trim", "Door", "door")]);
    expect(e.door.unit).toBe("qt");
  });

  it("door CASING is trim, not a door", () => {
    // Casing is trim around the opening, painted with the trim. Treating it as
    // a door would drag a whole trim run into quarts.
    expect(isDoorSurface("Door")).toBe(true);
    expect(isDoorSurface("Door casing")).toBe(false);
    expect(isDoorSurface("Door jamb")).toBe(false);
    expect(isDoorSurface("Walls")).toBe(false);
  });

  it("an accent wall flags the WALLS line, not just the accent line", () => {
    // The walls quantity is the one thrown off — part of that wall is now a
    // different colour. Detecting per-colour flagged only the accent line.
    const r = room(15, 20, 8, {
      roomLabel: "Living Room",
      surfaces: [surf("walls", "Walls", "wall", "Walls"), surf("unsized", "Accent Wall", "accent", "Accent")],
    });
    const e = byColor([r]);
    expect(e.wall.accentWallReview).toBe(true);
    expect(e.accent.accentWallReview).toBe(true);
  });

  it("an accent wall mentioned only in the notes still flags it", () => {
    const r = room(15, 20, 8, {
      roomLabel: "Living Room",
      notes: "prep and paint - accent wall on the north side",
      surfaces: [surf("walls", "Walls", "wall", "Walls")],
    });
    expect(byColor([r]).wall.accentWallReview).toBe(true);
  });

  it("a normal room is not flagged", () => {
    const r = room(15, 20, 8, { roomLabel: "Living Room", notes: "prep and paint", surfaces: [surf("walls", "Walls", "wall", "Walls")] });
    expect(byColor([r]).wall.accentWallReview).toBe(false);
  });

  it("both flags actually render on the order screen", () => {
    // They were computed and shown nowhere — the kitchen "please review" note
    // existed only in the data for four days.
    const src = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
    expect(src).toMatch(/e\.accentWallReview &&/);
    expect(src).toMatch(/\{e\.defaultedNote\}/);
  });
});

/**
 * Katie item 8 — a hand-typed colour line can be a 5-gallon pail.
 *
 * Only on custom lines. An estimate already rolls into buckets on its own via
 * packageGallons, so offering it there would be two ways to say one thing.
 */
describe("buckets on custom colour lines", () => {
  it("a bucket counts as five gallons in the order total", () => {
    const base = { buckets: 0, cans: 0, quarts: 0, sizedColors: 0, reviewColors: 0 };
    const t = addCustomItemsToTotal(base, [{ qty: 2, unit: "bucket" }]);
    // 2 pails = 10 gallons = 2 buckets + 0 cans
    expect(t.buckets).toBe(2);
    expect(t.cans).toBe(0);
  });

  it("mixes with gallons and quarts without losing either", () => {
    const base = { buckets: 0, cans: 0, quarts: 0, sizedColors: 0, reviewColors: 0 };
    const t = addCustomItemsToTotal(base, [
      { qty: 1, unit: "bucket" },
      { qty: 2, unit: "gal" },
      { qty: 3, unit: "qt" },
    ]);
    expect(t.buckets * 5 + t.cans).toBe(7); // 5 + 2
    expect(t.quarts).toBe(3);
  });

  it("reads as pails, not as a raw number", () => {
    expect(formatBucketsCans(0, 2, "bucket")).toBe("2 buckets (×5 gal)");
    expect(formatBucketsCans(0, 1, "bucket")).toBe("1 bucket (×5 gal)");
  });

  it("survives the round-trip through a stored override", () => {
    // build-state must accept "bucket" or a saved order silently reverts to gal.
    const src = readFileSync(join(process.cwd(), "lib/supplier-order/build-state.ts"), "utf8");
    expect(src).toMatch(/"gal", "qt", "bucket"/);
  });

  it("the vendor email says gallons, not the word bucket", () => {
    // "2 bucket — Behr 56" means nothing at a paint counter.
    const src = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
    expect(src).toMatch(/raw === "bucket" \? `x \$\{GALLONS_PER_BUCKET\} gal` : raw/);
  });

  it("custom lines offer it outright", () => {
    // A hand-typed colour has no computed quantity to reason about, so the
    // pail is just another container choice.
    const src = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
    expect(src).toMatch(/<option value="bucket">/);
  });

  it("estimate lines offer it CONDITIONALLY, from five gallons", () => {
    // This changed on 2026-09-09. Buckets used to be custom-lines-only because
    // the estimator rolled them up on its own; now it does not, so the choice
    // has to exist on an estimate line too — but only where a pail makes sense.
    const src = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
    expect(src).toMatch(/\["gal", "qt", "bucket"\]/);
    expect(src).toMatch(/unit === "gal" && total >= 5/);
  });
});

/**
 * Karan 2026-09-09, on the order screen:
 *   "if I have 5 gallons it shouldn't automatically [convert] — instead when we
 *    add 5 gallons it gives us another option for bucket next to Gallon/Quart"
 *   "when I add like a gallon there's a small delay to it"
 */
describe("buckets are chosen, not computed", () => {
  const view = () => readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");

  it("the Bucket option appears only at five gallons and up", () => {
    // Below five it would let someone order a pail for two gallons of paint.
    expect(view()).toMatch(/unit === "gal" && total >= 5/);
  });

  it("and only from gallons — five QUARTS is not a pail", () => {
    // 5 qt is 1.25 gal. Offering Bucket there converts to nothing.
    const v = view();
    const gate = v.slice(v.indexOf("Bucket appears once a line"), v.indexOf("as PaintUnit[]"));
    expect(gate).toMatch(/unit === "gal"/);
  });

  it("a line already on Bucket keeps the option even if it drops below five", () => {
    // Otherwise the control the worker is using vanishes under them.
    expect(view()).toMatch(/\|\| unit === "bucket"/);
  });

  it("the toggle names it", () => {
    expect(view()).toMatch(/u === "gal" \? "Gallon" : u === "qt" \? "Quart" : "Bucket"/);
  });
});

describe("stepping a quantity does not queue server rebuilds", () => {
  it("the draft rebuild waits for the stepping to stop", () => {
    const v = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
    const m = /const DRAFT_DEBOUNCE_MS = (\d+);/.exec(v);
    expect(m, "no debounce constant").toBeTruthy();
    // 150ms fired a Salesforce-backed rebuild between presses.
    expect(Number(m![1])).toBeGreaterThanOrEqual(400);
    expect(v).toMatch(/\}, DRAFT_DEBOUNCE_MS\);/);
  });
});
