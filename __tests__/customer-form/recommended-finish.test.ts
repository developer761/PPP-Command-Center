import { describe, it, expect } from "vitest";
import { recommendedFinishes, recommendationReason } from "@/lib/customer-form/recommended-finish";
import { finishOptionsFor, BASE_FINISHES } from "@/lib/customer-form/material-types";
import { roomTypeTextFrom } from "@/lib/rooms/room-type";
import { roomLabelFrom } from "@/lib/customer-form/room-label";

/**
 * "Precision Painting Plus — Standardized Paint Finishes, Interior &
 * Exterior" (Mac's guide, sent on by Kate 2026-09-22).
 *
 * The table below IS the guide. If PPP revises it, change these rows and the
 * code follows — not the other way round.
 */

const INTERIOR: Array<[surface: string, room: string, want: string]> = [
  // Area / surface        room label            first recommendation
  ["Ceiling",              "Living Room",        "Flat"],           // main-area ceilings → Flat
  ["Ceiling",              "Bedroom",            "Flat"],
  ["Ceiling",              "Hallway",            "Flat"],
  ["Ceiling",              "Kitchen",            "Flat"],           // kitchen ceilings → Flat or K&B
  ["Ceiling",              "Bathroom",           "Matte"],          // bathroom ceilings → low-sheen
  ["Walls",                "Living Room",        "Eggshell"],       // main-area walls → Matte or Eggshell
  ["Walls",                "Primary Bedroom",    "Eggshell"],
  ["Walls",                "Bathroom",           "Satin"],          // bathroom walls → Satin
  ["Walls",                "Powder Room",        "Satin"],
  ["Walls",                "Master Bath",        "Satin"],
  ["Trim",                 "Living Room",        "Semi-Gloss"],     // trim/doors/base/crown → Semi-Gloss
  ["Door",                 "Bedroom",            "Semi-Gloss"],
  ["Window",               "Bathroom",           "Semi-Gloss"],     // trim stays trim, even in a bathroom
  ["Floor",                "Basement",           "Satin"],
];

const EXTERIOR: Array<[surface: string, want: string]> = [
  ["Walls", "Low Lustre"],    // siding → Low Lustre
  ["Siding", "Low Lustre"],
  ["Trim", "Soft Gloss"],     // exterior trim → Soft Gloss
  ["Door", "Soft Gloss"],     // exterior doors → Soft Gloss
  ["Soffit", "Soft Gloss"],   // soffits → Soft Gloss
  ["Ceiling", "Soft Gloss"],  // a porch ceiling IS a soffit
];

describe("the guide's interior table", () => {
  for (const [surface, room, want] of INTERIOR) {
    it(`${room} · ${surface} → ${want}`, () => {
      expect(recommendedFinishes(surface, room, "interior")[0]).toBe(want);
    });
  }

  it("Kate's example, by name: a bathroom's walls are Satin, not Eggshell", () => {
    expect(recommendedFinishes("Walls", "Bathroom", "interior")[0]).toBe("Satin");
    expect(recommendedFinishes("Walls", "Living Room", "interior")[0]).toBe("Eggshell");
  });
});

describe("the guide's exterior table", () => {
  for (const [surface, want] of EXTERIOR) {
    it(`${surface} → ${want}`, () => {
      expect(recommendedFinishes(surface, "Exterior", "exterior")[0]).toBe(want);
    });
  }

  it("but exterior woodwork still recommends NOTHING", () => {
    // Katie item 19: a rear deck is stained or solid-coated depending on the
    // product, and a sheen auto-filled there is one the supplier cannot mix.
    for (const s of ["Deck", "Fence", "Railing"]) {
      expect(recommendedFinishes(s, "Rear Deck", "exterior"), s).toEqual([]);
    }
  });
});

describe("it knows which rooms are really bathrooms", () => {
  // Same classifier the gallon estimator uses, so the two cannot drift.
  it("counts the ones PPP means", () => {
    for (const label of ["Bathroom", "Master Bath", "Powder Rm", "Hall bath", "En-suite"]) {
      expect(recommendedFinishes("Walls", label, "interior")[0], label).toBe("Satin");
    }
  });

  it("and not the ones it doesn't", () => {
    // A pool bathhouse is a building; a combined area is not a bathroom.
    for (const label of ["Pool bathhouse", "Bath House", "Sunbathing deck", "Bedroom & Bath"]) {
      expect(recommendedFinishes("Walls", label, "interior")[0], label).toBe("Eggshell");
    }
  });
});

describe("a recommendation is only ever a suggestion", () => {
  it("gives way to what the product is actually sold in", () => {
    // Aura Bath & Spa is Matte and nothing else. Recommending Satin into a
    // line that cannot be mixed in Satin would be an order no store can fill,
    // so the caller walks the preference order — that is why this returns a
    // LIST and not one string.
    const prefs = recommendedFinishes("Walls", "Bathroom", "interior");
    const sold = finishOptionsFor(BASE_FINISHES, "Aura Bath & Spa Matte", "interior");
    const firstAvailable = prefs.find((f) => sold.includes(f));
    expect(prefs[0]).toBe("Satin");
    if (sold.length > 0 && !sold.includes("Satin")) {
      expect(firstAvailable).not.toBe("Satin");
    }
  });

  it("always offers a second choice where the guide names one", () => {
    // Bathroom walls: "Satin / Kitchen & Bath product". Main walls: "Matte or
    // Eggshell". Trim: "Semi-Gloss or Satin". A single-element list where the
    // guide gives two would strand a product that lacks the first.
    expect(recommendedFinishes("Walls", "Bathroom", "interior").length).toBeGreaterThan(1);
    expect(recommendedFinishes("Walls", "Living Room", "interior")).toContain("Matte");
    expect(recommendedFinishes("Trim", "Living Room", "interior")).toContain("Satin");
  });

  it("never invents a finish that isn't in PPP's vocabulary", () => {
    const VOCAB = new Set(["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Low Lustre", "Soft Gloss"]);
    let checked = 0;
    for (const scope of ["interior", "exterior"] as const) {
      for (const surface of ["Walls", "Ceiling", "Trim", "Door", "Window", "Floor", "Cabinets", "Accent Wall", "Closet", "Shelves", "Siding", "Soffit", "Deck"]) {
        for (const room of ["Living Room", "Bathroom", "Kitchen", "", "Pool bathhouse"]) {
          for (const f of recommendedFinishes(surface, room, scope)) {
            expect(VOCAB.has(f), `${scope} ${surface} ${room} → ${f}`).toBe(true);
            checked++;
          }
        }
      }
    }
    // Proof this measured something rather than iterating over empty lists.
    expect(checked).toBeGreaterThan(50);
  });
});

describe("the hint shown next to the dropdown", () => {
  it("explains a bathroom's Satin, which is the surprising one", () => {
    expect(recommendationReason("Walls", "Bathroom", "interior")).toMatch(/Satin/);
    expect(recommendationReason("Ceiling", "Bathroom", "interior")).toMatch(/low-sheen/);
  });

  it("stays quiet everywhere the answer is the ordinary one", () => {
    expect(recommendationReason("Walls", "Living Room", "interior")).toBeNull();
    expect(recommendationReason("Ceiling", "Bedroom", "interior")).toBeNull();
    expect(recommendationReason("Trim", "Bathroom", "interior")).toBeNull();
    expect(recommendationReason("Walls", "Exterior", "exterior")).toBeNull();
  });
});

/* ── the shape PPP's Salesforce data is actually in ──────────────────────── */

describe("a bathroom PPP's data does not call a bathroom", () => {
  // Measured 2026-09-22 across 30,000 live line items: the room TYPE is in
  // ProductName__c and AreaLabel__c holds a qualifier. Classifying on the
  // display name alone — which is what `roomLabelFrom` correctly returns —
  // answered "not a bathroom" for 1,781 of the 1,784 bathrooms on the org.
  const REAL: Array<[area: string, product: string]> = [
    ["Master", "Interior Painting: Bathroom: Master"],
    ["off living room", "Interior Painting: Bathroom: off living room"],
    ["1st Floor", "Interior Painting: Bathroom: 1st Floor"],
    ["Front", "Interior Painting: Bathroom: Front"],
    ["Guest", "Interior Painting: Bathroom: Guest"],
    ["2nd Floor", "Interior Painting: Bathroom: 2nd Floor"],
  ];

  for (const [area, product] of REAL) {
    it(`"${area}" + "${product}" is a bathroom`, () => {
      expect(recommendedFinishes("Walls", roomTypeTextFrom(area, product), "interior")[0]).toBe("Satin");
    });
  }

  it("the display label alone still misses them — which is why this exists", () => {
    // roomLabelFrom is not wrong; it answers a different question ("what should
    // this room be CALLED"). This test records the difference so nobody
    // 'simplifies' the two back into one.
    for (const [area, product] of REAL) {
      expect(roomLabelFrom(area, product)).toBe(area);
      expect(recommendedFinishes("Walls", roomLabelFrom(area, product), "interior")[0]).toBe("Eggshell");
    }
  });

  it("and a kitchen the same way", () => {
    expect(
      recommendedFinishes("Ceiling", roomTypeTextFrom("1st Floor", "Interior Painting: Kitchen: 1st Floor"), "interior")[0]
    ).toBe("Flat");
    // A real bedroom must NOT become a bathroom just because both fields are read.
    expect(
      recommendedFinishes("Walls", roomTypeTextFrom("Master", "Interior Painting: Bedroom: Master"), "interior")[0]
    ).toBe("Eggshell");
  });

  it("a combined area is still not one room", () => {
    // The conjunction guard has to survive reading both fields, or
    // "Kitchen & Dining" starts taking the kitchen rules again.
    expect(
      recommendedFinishes("Walls", roomTypeTextFrom("1st Floor", "Interior Painting: Kitchen & Dining: 1st Floor"), "interior")[0]
    ).toBe("Eggshell");
    expect(
      recommendedFinishes("Walls", roomTypeTextFrom("Pool", "Interior Painting: Bath House: Pool"), "interior")[0]
    ).toBe("Eggshell");
  });
});
