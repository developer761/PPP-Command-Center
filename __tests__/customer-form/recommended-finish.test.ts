import { describe, it, expect } from "vitest";
import { recommendedFinishes } from "@/lib/customer-form/recommended-finish";
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
  ["Ceiling",              "Bathroom",           "Satin"],          // bathroom ceilings → Satin (Kate 2026-09-22)
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

  it("…and her follow-up: the ceiling is Satin too, the whole room", () => {
    // Kate 2026-09-22: "satin can be the standard rec for bathroom walls and
    // ceilings." The guide itself only said "low-sheen" for the ceiling.
    expect(recommendedFinishes("Ceiling", "Bathroom", "interior")[0]).toBe("Satin");
    expect(recommendedFinishes("Ceiling", "Master Bath", "interior")[0]).toBe("Satin");
    // A main-area ceiling is untouched by that — still Flat.
    expect(recommendedFinishes("Ceiling", "Living Room", "interior")[0]).toBe("Flat");
    expect(recommendedFinishes("Ceiling", "Kitchen", "interior")[0]).toBe("Flat");
  });

  it("but a product not sold in Satin still gets a low sheen, not a blank", () => {
    // Aura Bath & Spa is Matte only; Regal Select Kitchen & Bath is Pearl only.
    // The preference order is what keeps those rooms from landing empty.
    expect(recommendedFinishes("Ceiling", "Bathroom", "interior")).toEqual(["Satin", "Matte", "Flat"]);
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
