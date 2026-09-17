import { describe, it, expect } from "vitest";
import {
  estimateOrderGallons,
  formatOrderQuantity,
  isWindowSurface,
  isDoorSurface,
  classifyRoomType,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * Three rules that were replacing a computed size rather than raising a small
 * one, found by auditing the bathroom split's own fixes.
 */

const surf = (label: string, colorId: string, kind: RoomTakeoff["surfaces"][number]["kind"] = "trim") =>
  ({ kind, surfaceLabel: label, colorId, colorName: "Decorator White", colorCode: "CC-20", finish: "Semi-Gloss" });

function room(label: string, w: number, l: number, over: Partial<RoomTakeoff> = {}): RoomTakeoff {
  return {
    woliId: `woli-${label}`, roomLabel: label,
    floorAreaSqft: w * l, wallSurfaceAreaSqft: 0, perimeterLf: 2 * (w + l), heightFt: 8,
    doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [surf("Trim", "trim-white")],
    ...over,
  };
}

describe("a bathroom ceiling is not always a quart", () => {
  it("a big one is sized honestly", () => {
    // The guard escaped only ABOVE a gallon, so everything from a quarter to a
    // whole gallon — a 12x15 bath, or three bathroom ceilings now on one line
    // — was replaced by a single quart.
    const [e] = estimateOrderGallons([
      room("Bathroom", 12, 15, { surfaces: [surf("Ceiling", "ceil-white", "ceiling")] }),
    ]);
    expect(e.unit ?? "gal").not.toBe("qt");
  });

  it("three bathrooms' ceilings in one color are not one quart between them", () => {
    const rooms = ["Bath 1", "Bath 2", "Powder Room"].map((n) =>
      room(n, 8, 10, { surfaces: [surf("Ceiling", "ceil-white", "ceiling")] })
    );
    const [e] = estimateOrderGallons(rooms);
    expect(formatOrderQuantity(e)).not.toBe("1 qt");
  });

  it("a small one still is", () => {
    const [e] = estimateOrderGallons([
      room("Bathroom", 5, 7, { surfaces: [surf("Ceiling", "ceil-white", "ceiling")] }),
    ]);
    expect(formatOrderQuantity(e)).toBe("1 qt");
  });

  it("a bathroom sized at a gallon on its own is not labelled 'defaulted'", () => {
    // The note is for a number we RAISED. Stamping it on an honest answer
    // teaches the estimator to ignore it.
    const [e] = estimateOrderGallons([room("Bathroom", 12, 14, { surfaces: [surf("Walls", "w", "walls")] })]);
    expect(e.cans).toBeGreaterThanOrEqual(1);
    if (e.cans > 1) expect(e.defaultedNote ?? "").not.toMatch(/defaulted/);
  });
});

describe("doors and windows are priced as themselves", () => {
  const doorRoom = (label: string) =>
    room(label, 10, 12, { doors: 3, surfaces: [surf("Door", "door-black")] });

  it("a whole house of doors is more than one gallon", () => {
    // The quart rule capped every door line at 1 gal, whatever the count.
    const out = estimateOrderGallons(["A","B","C","D","E","F","G","H","I","J"].map(doorRoom));
    expect(out[0].gallons).toBeGreaterThan(1);
  });

  it("a window-only color is not charged for the room's baseboard", () => {
    const out = estimateOrderGallons([
      room("Bedroom", 10, 12, { windows: 2, surfaces: [surf("Window", "sash-white")] }),
      room("Study", 10, 12, { windows: 2, surfaces: [surf("Window", "sash-white")] }),
    ]);
    expect(out[0].unit).toBe("qt");
  });

  it("real trim in those same two rooms is still a gallon", () => {
    const out = estimateOrderGallons([room("Bedroom", 10, 12), room("Study", 10, 12)]);
    expect(out[0].unit ?? "gal").toBe("gal");
  });

  it("door faces are not paid for twice when the room lists Doors separately", () => {
    // paintDoorFaces adds them to the trim line; the Door surface adds them
    // again. Same job, one color on both surfaces.
    const withOwnDoorLine = estimateOrderGallons([
      room("Bedroom", 12, 14, {
        doors: 4, paintDoorFaces: true,
        surfaces: [surf("Trim", "one-white"), surf("Door", "one-white")],
      }),
    ])[0].totalSqft;
    const trimOnly = estimateOrderGallons([
      room("Bedroom", 12, 14, { doors: 4, paintDoorFaces: true, surfaces: [surf("Trim", "one-white")] }),
    ])[0].totalSqft;
    // The doors are counted once: the combined line is the trim WITHOUT its
    // door-face add-on, plus the doors.
    expect(withOwnDoorLine).toBeLessThan(trimOnly + 4 * 20 * 1.5);
  });

  it("a door line in a room with no measurements says it needs one", () => {
    const out = estimateOrderGallons([
      { ...room("Unmeasured", 0, 0, { surfaces: [surf("Door", "door-black")] }),
        floorAreaSqft: 0, perimeterLf: 0, wallSurfaceAreaSqft: 0, heightFt: 0 },
    ]);
    expect(out[0].needsMeasurement || out[0].manualOnly).toBe(true);
  });

  it("casing stays with the trim, sashes and doors do not", () => {
    expect(isDoorSurface("Door casing")).toBe(false);
    expect(isDoorSurface("Doors")).toBe(true);
    expect(isWindowSurface("Window")).toBe(true);
    expect(isWindowSurface("Window sill")).toBe(false);
    // A combined label is trim: the baseboard is the bigger half and
    // under-ordering it is the worse mistake.
    expect(isWindowSurface("Trim & Windows")).toBe(false);
  });
});

describe("the room labels PPP actually types", () => {
  it("shortened bathrooms still count", () => {
    for (const label of ["En suite", "Powder Rm", "Bathrm", "Half bath", "Bath 2", "WC"]) {
      expect(classifyRoomType(label)).toBe("bathroom");
    }
  });
});
