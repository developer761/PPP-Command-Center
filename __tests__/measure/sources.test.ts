import { describe, it, expect } from "vitest";
import { suggestFromHistory, roomType, normaliseRoomLabel, MIN_SAMPLES } from "@/lib/measure/from-history";
import { isFirmEnoughToOrder } from "@/lib/measure/types";

/**
 * The history source, and the honesty rules that keep the tool trustworthy.
 *
 * Measured on the live org before building this: room labels inside one type
 * vary about 2× (the "main" bucket ran p25 84, median 120, p75 192). A median
 * is therefore a starting point, never a measurement — and the tool has to say
 * so, or the crew learns it guesses and stops trusting the good sources too.
 */
const sample = (sqft: number, label: string) => ({ sqft, label });

describe("room typing", () => {
  it("buckets the many ways PPP writes one room", () => {
    expect(roomType("Master Bedroom")).toBe("master");
    expect(roomType("master bed 2")).toBe("master");
    expect(roomType("Primary Suite")).toBe("master");
    expect(roomType("Powder Room")).toBe("bathroom");
    expect(roomType("Ensuite")).toBe("bathroom");
    expect(roomType("Upstairs Hall")).toBe("hall");
  });

  it("returns null rather than guessing on an unrecognisable label", () => {
    // Better no suggestion than a confident wrong bucket.
    expect(roomType("Area")).toBeNull();
    expect(roomType("")).toBeNull();
    expect(roomType("zone 4")).toBeNull();
  });

  it("normalises punctuation and case without mangling words", () => {
    // Deliberately does NOT strip "room" — that would turn "bedroom" into
    // "bed" and "bathroom" into "bath", changing what the label means.
    expect(normaliseRoomLabel("Master Bedroom #2")).toBe("master bedroom");
    expect(normaliseRoomLabel("  KITCHEN  ")).toBe("kitchen");
  });

  it("matches PPP's single-word room names", () => {
    // The regression that prompted prefix matching: `\bbath\b` never matches
    // "Bathroom", so every bathroom typed as unknown and got no suggestion.
    expect(roomType("Bathroom")).toBe("bathroom");
    expect(roomType("Bedroom")).toBe("bedroom");
    expect(roomType("Hallway")).toBe("hall");
  });
});

describe("suggestFromHistory", () => {
  const baths = Array.from({ length: 10 }, (_, i) => sample(40 + i * 5, "Bathroom"));

  it("suggests the median of comparable rooms", () => {
    const s = suggestFromHistory("Powder Bath", baths)!;
    expect(s.source).toBe("history");
    expect(s.sqft).toBeGreaterThan(40);
    expect(s.sqft).toBeLessThan(90);
  });

  it("shows the RANGE, not just a number", () => {
    // A lone number reads as a measurement. The spread is the honest part.
    const s = suggestFromHistory("Powder Bath", baths)!;
    expect(s.rationale).toMatch(/\d+–\d+ sq ft/);
    expect(s.rationale).toMatch(/Adjust if/);
  });

  it("never claims better than low confidence", () => {
    const s = suggestFromHistory("Powder Bath", baths)!;
    expect(s.confidence).toBe("low");
    // …and low is explicitly not firm enough to send a vendor a hard quantity.
    expect(isFirmEnoughToOrder(s.confidence)).toBe(false);
  });

  it("stays silent on a thin sample", () => {
    // Two past bathrooms is not evidence. Offering a number off it teaches the
    // crew the tool guesses.
    const thin = baths.slice(0, MIN_SAMPLES - 1);
    expect(suggestFromHistory("Powder Bath", thin)).toBeNull();
  });

  it("ignores rooms of a different type", () => {
    const mixed = [...baths, ...Array.from({ length: 20 }, () => sample(400, "Living Room"))];
    const s = suggestFromHistory("Bathroom", mixed)!;
    // The 400s must not drag a bathroom estimate upward.
    expect(s.sqft).toBeLessThan(100);
  });

  it("discards impossible values", () => {
    const dirty = [...baths, sample(0, "Bathroom"), sample(99999, "Bathroom"), sample(-5, "Bathroom")];
    const s = suggestFromHistory("Bathroom", dirty)!;
    expect(s.sqft).toBeLessThan(100);
  });
});

describe("confidence gates what the vendor is told", () => {
  it("only a measurement or a photo is firm enough to order on", () => {
    expect(isFirmEnoughToOrder("high")).toBe(true);
    expect(isFirmEnoughToOrder("medium")).toBe(true);
    // A share of a building's square footage is a guess wearing a number.
    expect(isFirmEnoughToOrder("low")).toBe(false);
  });
});
