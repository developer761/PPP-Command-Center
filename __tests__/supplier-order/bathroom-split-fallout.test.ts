import { describe, it, expect } from "vitest";
import { roomTypeTextFrom } from "@/lib/rooms/room-type";
import {
  estimateOrderGallons,
  applyQuantityOverrides,
  classifyRoomType,
  quantityKey,
  formatOrderQuantity,
  type RoomTakeoff,
} from "@/lib/supplier-order/estimate-gallons";

/**
 * What the bathroom split (2026-09-17) broke, found by auditing it afterwards.
 *
 * Splitting bathrooms onto their own line was right. But three rules had been
 * written when a bathroom bucket could only exist if the color was used in
 * bathrooms and NOWHERE else — a rare shape. The split makes it the normal
 * shape, and each of those rules then fired on jobs it had never touched.
 */

const surf = (kind: RoomTakeoff["surfaces"][number]["kind"], label: string, colorId: string) =>
  ({ kind, surfaceLabel: label, colorId, colorName: "White Dove", colorCode: "OC-17", finish: "Eggshell" });

function room(label: string, w: number, l: number, over: Partial<RoomTakeoff> = {}): RoomTakeoff {
  return {
    woliId: `woli-${label}`, roomLabel: label,
    floorAreaSqft: w * l, wallSurfaceAreaSqft: 0, perimeterLf: 2 * (w + l), heightFt: 8,
    doors: 0, windows: 0, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [surf("walls", "Walls", "white")],
    ...over,
  };
}

describe("the bathroom default is a floor, not a cap", () => {
  it("a big bathroom is sized honestly", () => {
    // A 20x30 pool bathhouse sharing the house color used to be part of a
    // bucket with ordinary rooms and was sized on real area. After the split it
    // is bathroom-only, and an unconditional `cans = 1` bought ONE gallon for
    // 800 sq ft of wall.
    const [e] = estimateOrderGallons([room("Pool bathhouse bath", 20, 30)]);
    expect(e.gallons).toBeGreaterThan(1);
  });

  it("a small bathroom still gets its gallon", () => {
    const [e] = estimateOrderGallons([room("Bathroom", 5, 8)]);
    expect(formatOrderQuantity(e)).toBe("1 gal");
    expect(e.defaultedNote ?? "").toMatch(/bathroom/i);
  });

  it("a big bathroom CEILING is sized honestly too", () => {
    const [e] = estimateOrderGallons([
      room("Bathroom", 20, 30, { surfaces: [surf("ceiling", "Ceiling", "white")] }),
    ]);
    // Not `e.unit ?? "gal"`: that reads "never sized" as "sized in gallons",
    // which is exactly how the ceiling hole stayed green while the vendor was
    // emailed TBD.
    expect(formatOrderQuantity(e)).toMatch(/ gal$/);
  });

  it("a small bathroom ceiling is still a quart", () => {
    const [e] = estimateOrderGallons([
      room("Bathroom", 5, 8, { surfaces: [surf("ceiling", "Ceiling", "white")] }),
    ]);
    expect(formatOrderQuantity(e)).toBe("1 qt");
  });
});

describe("a bathhouse is not a bathroom", () => {
  it("matches the rooms PPP means", () => {
    for (const label of ["Bathroom", "Master Bath", "Powder Room", "Ensuite", "En-Suite bath", "Hall bath"]) {
      expect(classifyRoomType(label)).toBe("bathroom");
    }
  });

  it("and not the ones it does not", () => {
    // Substring matching decided only a note before the split; now it decides
    // what is bought, so it has to be right.
    for (const label of ["Pool bathhouse", "Bath House", "Sunbathing deck", "Bathurst Room"]) {
      expect(classifyRoomType(label)).not.toBe("bathroom");
    }
  });

  it("a kitchen joined to a bathroom is neither — it is a combined area", () => {
    // This used to answer "kitchen", which capped the whole combined area at
    // one gallon for cabinets that cover a corner of it. The two guards had
    // drifted: the bathroom branch treated a joined kitchen as combined, the
    // kitchen branch did not treat a joined bath the same way. They read one
    // list now, so every pairing answers the same in both directions.
    expect(classifyRoomType("Kitchen & Bath")).toBe(null);
    expect(classifyRoomType("Kitchen & Laundry")).toBe(null);
    expect(classifyRoomType("Kitchen / Mudroom")).toBe(null);
    expect(classifyRoomType("Bath & Kitchen")).toBe(null);
    // …while each on its own, and each named by where it is, still classifies.
    expect(classifyRoomType("Kitchen")).toBe("kitchen");
    expect(classifyRoomType("Kitchenette")).toBe("kitchen");
    expect(classifyRoomType("Hall bath")).toBe("bathroom");
    expect(classifyRoomType("Master Bath - 2nd floor")).toBe("bathroom");
  });
});

describe("the split leaves trim alone", () => {
  const trimIn = (label: string, w: number, l: number) =>
    room(label, w, l, { surfaces: [surf("trim", "Trim", "trim-white")] });

  it("a bedroom and a bathroom sharing one trim color is ONE line", () => {
    // Splitting trim would both invent a line no bathroom product can carry
    // (they are Matte-only and Pearl-only) and turn Jason's "2+ rooms is a
    // gallon" into two quarts.
    const out = estimateOrderGallons([trimIn("Bedroom", 10, 12), trimIn("Bathroom", 5, 8)]);
    expect(out).toHaveLength(1);
    expect(formatOrderQuantity(out[0])).toBe("1 gal");
  });

  it("but walls in the same two rooms are still two lines", () => {
    const out = estimateOrderGallons([room("Bedroom", 10, 12), room("Bathroom", 5, 8)]);
    expect(out).toHaveLength(2);
  });
});

describe("a door is still a quart", () => {
  const doorIn = (label: string) =>
    room(label, 10, 12, { doors: 1, surfaces: [surf("trim", "Door", "door-black")] });

  it("in one room", () => {
    const [e] = estimateOrderGallons([doorIn("Bedroom")]);
    expect(formatOrderQuantity(e)).toBe("1 qt");
  });

  it("…and in four, where the trim rate had made it a gallon", () => {
    // Katie item 6. A door-only color was inheriting the whole room's
    // perimeter, which the linear-foot rate then priced as baseboard.
    const out = estimateOrderGallons(["A", "B", "C", "D"].map(doorIn));
    expect(out).toHaveLength(1);
    expect(out[0].unit).toBe("qt");
  });

  it("real trim in four rooms is still a gallon — the rule it must not swallow", () => {
    const out = estimateOrderGallons(
      ["A", "B", "C", "D"].map((n) => room(n, 10, 12, { surfaces: [surf("trim", "Trim", "trim-white")] }))
    );
    expect(formatOrderQuantity(out[0])).toMatch(/ gal$/);
  });
});

describe("an order saved before the split still means what it said", () => {
  it("a typed ZERO on a bathroom line is still 'do not buy this'", () => {
    // The pre-split draft holds the PLAIN key. Reading only the new one missed
    // it and sent the estimate — one gallon of paint PPP had decided against.
    const out = estimateOrderGallons([room("Bathroom", 5, 8)]);
    const legacy = new Map([[quantityKey(out[0].colorId, out[0].finish), { buckets: 0, cans: 0, unit: "gal" as const }]]);
    const applied = applyQuantityOverrides(out, legacy);
    expect(applied[0].excluded).toBe(true);
    expect(applied[0].cans).toBe(0);
  });

  it("a typed quantity on a bathroom line survives the deploy", () => {
    const out = estimateOrderGallons([room("Bathroom", 5, 8)]);
    const legacy = new Map([[quantityKey(out[0].colorId, out[0].finish), { buckets: 0, cans: 6, unit: "gal" as const }]]);
    expect(applyQuantityOverrides(out, legacy)[0].cans).toBe(6);
  });

  it("the new key still wins when both exist", () => {
    const out = estimateOrderGallons([room("Bathroom", 5, 8)]);
    const both = new Map([
      [quantityKey(out[0].colorId, out[0].finish), { buckets: 0, cans: 6, unit: "gal" as const }],
      [quantityKey(out[0].colorId, out[0].finish, true), { buckets: 0, cans: 2, unit: "gal" as const }],
    ]);
    expect(applyQuantityOverrides(out, both)[0].cans).toBe(2);
  });

  it("a NON-bathroom line never reads a bathroom key", () => {
    const out = estimateOrderGallons([room("Bedroom", 10, 12)]);
    const bathKey = new Map([[quantityKey(out[0].colorId, out[0].finish, true), { buckets: 0, cans: 9, unit: "gal" as const }]]);
    expect(applyQuantityOverrides(out, bathKey)[0].cans).not.toBe(9);
  });
});

/* ── the bathrooms the split was never reaching ──────────────────────────── */

describe("a bathroom named the way PPP's work orders name them", () => {
  /**
   * Measured 2026-09-22 across 30,000 live WorkOrderLineItems: 1,781 of the
   * org's 1,784 bathrooms carry the room type in ProductName__c and a
   * qualifier in AreaLabel__c — "Master", "Guest", "1st Floor". The estimator
   * classified on the DISPLAY label, which is the qualifier, so Jason and
   * Alex's bathroom line had been firing on three rooms out of 1,784.
   */
  const bathroom = (area: string, product: string): RoomTakeoff => ({
    woliId: `w-${area}`,
    roomLabel: area,
    roomTypeText: roomTypeTextFrom(area, product),
    floorAreaSqft: 40, wallSurfaceAreaSqft: 0, perimeterLf: 26, heightFt: 8,
    doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
    surfaces: [surf("walls", "Walls", "white")],
  });

  it("gets its own order line, like any other bathroom", () => {
    const out = estimateOrderGallons([
      bathroom("Master", "Interior Painting: Bathroom: Master"),
      {
        woliId: "w-bed", roomLabel: "Bedroom",
        roomTypeText: roomTypeTextFrom("Bedroom", "Interior Painting: Bedroom: Bedroom"),
        floorAreaSqft: 180, wallSurfaceAreaSqft: 0, perimeterLf: 54, heightFt: 8,
        doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
        surfaces: [surf("walls", "Walls", "white")],
      },
    ]);
    // One color, two lines: the bathroom is separable so it can take a
    // Kitchen & Bath product.
    expect(out).toHaveLength(2);
    expect(out.filter((e) => e.isBathroom)).toHaveLength(1);
  });

  it("and without the type text it is missed — the bug this pins", () => {
    // Same two rooms, classified on the display label alone.
    const out = estimateOrderGallons([
      { ...bathroom("Master", "Interior Painting: Bathroom: Master"), roomTypeText: undefined },
      {
        woliId: "w-bed", roomLabel: "Bedroom", roomTypeText: undefined,
        floorAreaSqft: 180, wallSurfaceAreaSqft: 0, perimeterLf: 54, heightFt: 8,
        doors: 1, windows: 1, closets: 0, coats: 0, paintDoorFaces: false,
        surfaces: [surf("walls", "Walls", "white")],
      },
    ]);
    expect(out.filter((e) => e.isBathroom)).toHaveLength(0);
  });
});
