import { describe, it, expect } from "vitest";
import {
  estimateOrderGallons,
  formatOrderQuantity,
  quantityKey,
  applyQuantityOverrides,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * Jason + Alex, 2026-09-17: "Bathrooms in the same color as non-bathrooms
 * needs to remain broken out for different paint products (regal kitchen &
 * bath or Aura bath & spa)."
 *
 * A bathroom takes a moisture-rated product in the SAME color, so its gallons
 * are bought separately. Grouped on color+finish alone they merged into one
 * line that can carry only one product — and the merge also cancelled the
 * bathroom's own 1-gallon default, since that fires only when every
 * contributing room is a bathroom.
 */

const walls = (colorId: string) => ({
  kind: "walls" as const,
  surfaceLabel: "Walls",
  colorId,
  colorName: "White Dove",
  colorCode: "OC-17",
  finish: "Eggshell",
});

function room(label: string, w: number, l: number, colorId = "white-dove"): RoomTakeoff {
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
    surfaces: [walls(colorId)],
  };
}

describe("a bathroom is ordered apart from the same color elsewhere", () => {
  it("one color in a bedroom and a bathroom is TWO lines", () => {
    const out = estimateOrderGallons([room("Bedroom", 12, 14), room("Bathroom", 5, 8)]);
    expect(out).toHaveLength(2);
    const bath = out.find((e) => e.isBathroom);
    const rest = out.find((e) => !e.isBathroom);
    expect(bath?.rooms).toEqual(["Bathroom"]);
    expect(rest?.rooms).toEqual(["Bedroom"]);
    // Same color and finish on both — the split is the room type, nothing else.
    expect(bath?.colorId).toBe(rest?.colorId);
    expect(bath?.finish).toBe(rest?.finish);
  });

  it("…and the bathroom keeps its own 1-gallon default", () => {
    // The merge used to cancel this: roomTypes held {bathroom, other}, so the
    // bathroom rule never fired and the bath was sized on combined area.
    const [bath] = estimateOrderGallons([room("Bathroom", 5, 8)]);
    expect(bath.defaultedNote ?? "").toMatch(/bathroom/i);
    expect(formatOrderQuantity(bath)).toBe("1 gal");
  });

  it("two bathrooms in one color stay together", () => {
    // The split is bathroom-vs-not, not room-by-room.
    const out = estimateOrderGallons([room("Bathroom", 5, 8), room("Powder Room", 4, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0].isBathroom).toBe(true);
    expect(out[0].rooms).toEqual(["Bathroom", "Powder Room"]);
  });

  it("nothing changes for a job with no bathroom", () => {
    const out = estimateOrderGallons([room("Bedroom", 12, 14), room("Hallway", 4, 12)]);
    expect(out).toHaveLength(1);
    expect(out[0].isBathroom).toBe(false);
    expect(out[0].rooms).toEqual(["Bedroom", "Hallway"]);
  });
});

describe("the key that carries the split", () => {
  it("a non-bathroom key is byte-identical to the old format", () => {
    // Saved drafts, quantity overrides and per-color product overrides are all
    // keyed this way. Changing the shape for every line would orphan them.
    expect(quantityKey("abc", "Eggshell")).toBe("abc::Eggshell");
    expect(quantityKey("abc", null)).toBe("abc::");
    expect(quantityKey("abc", "Eggshell", false)).toBe("abc::Eggshell");
  });

  it("a bathroom key is distinct", () => {
    expect(quantityKey("abc", "Eggshell", true)).toBe("abc::Eggshell::bath");
  });

  it("a typed quantity lands on the line it was typed on", () => {
    const out = estimateOrderGallons([room("Bedroom", 12, 14), room("Bathroom", 5, 8)]);
    const bath = out.find((e) => e.isBathroom)!;
    const rest = out.find((e) => !e.isBathroom)!;
    const overrides = new Map([
      [quantityKey(bath.colorId, bath.finish, true), { buckets: 0, cans: 2, unit: "gal" as const }],
    ]);
    const applied = applyQuantityOverrides(out, overrides);
    expect(applied.find((e) => e.isBathroom)!.cans).toBe(2);
    // …and not on the bedroom, which is what a shared key would have done.
    expect(applied.find((e) => !e.isBathroom)!.cans).toBe(rest.cans);
  });
});
