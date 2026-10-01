import { describe, it, expect } from "vitest";
import { parseColorNotes, isRemark, splitQualifier } from "@/lib/supplier-order/color-note-parse";

/**
 * Katie's own test note, 2026-10-01, verbatim — she wrote it to break the
 * parser on purpose and it did. Every assertion below is one of the three
 * things she reported.
 */
const KATIE_NOTE = `I want different colors for different rooms, so I'm entering it here instead. Also curious if I could add an accent wall, maybe in a plum color like Carter Plum CW-355

All rooms:
Ceiling: Super White - Flat (eggshell for the bathroom ceiling)
Trim: OC-17 White Dove - Semigloss

Wall color for each room --
Living Room:
Walls: HC-172 Revere Pewter - Eggshell

Dining Room:
Walls: HC-45 Shaker Beige - Eggshell

Kitchen:
Walls: OC-117 Simply White - Eggshell

Bathroom:
Walls: HC-161 Templeton Gray - Satin`;

const parsed = parseColorNotes(KATIE_NOTE);
const lines = parsed.offers.map((o) => o.line);

describe("what is offered as something to buy", () => {
  it("does not offer the customer's sentence about accent walls", () => {
    // It became a buy-list row with a quantity box, and was marked "On order".
    // It mentions a real color (Carter Plum CW-355), which is exactly why a
    // "contains a color code" rule would not have caught it.
    expect(lines.some((l) => /accent wall/i.test(l))).toBe(false);
    expect(lines.some((l) => /curious/i.test(l))).toBe(false);
  });

  it("does not offer a section header", () => {
    expect(lines).not.toContain("Wall color for each room --");
    expect(lines.some((l) => /wall color for each room/i.test(l))).toBe(false);
  });

  it("still offers every actual color", () => {
    // The thing that must not break while fixing the above. Six colors: two
    // whole-house, four per-room.
    for (const want of [
      "Ceiling: Super White - Flat",
      "Trim: OC-17 White Dove - Semigloss",
      "Walls: HC-172 Revere Pewter - Eggshell",
      "Walls: HC-45 Shaker Beige - Eggshell",
      "Walls: OC-117 Simply White - Eggshell",
      "Walls: HC-161 Templeton Gray - Satin",
    ]) {
      expect(lines, want).toContain(want);
    }
    expect(parsed.offers).toHaveLength(6);
  });
});

describe("the instruction inside the parentheses", () => {
  it("captures 'eggshell for the bathroom ceiling' instead of gluing it on", () => {
    // Katie: "if they state 'all ceilings' or something similar, that isn't
    // captured". It used to ride along inside the product text.
    const ceiling = parsed.offers.find((o) => o.line.startsWith("Ceiling:"));
    expect(ceiling?.qualifier).toBe("eggshell for the bathroom ceiling");
    expect(ceiling?.line).toBe("Ceiling: Super White - Flat");
  });

  it("leaves a color code alone", () => {
    // "(HC-6)" is part of the color, not an instruction about it.
    expect(splitQualifier("Siding: Kendall Charcoal (HC-166)").qualifier).toBeNull();
    expect(splitQualifier("Walls: Simply White (2 gal)").qualifier).toBeNull();
  });
});

describe("which room each color belongs to", () => {
  it("reads the room headings the rep wrote", () => {
    // Katie: "rooms aren't mentioned". All seven rooms lived in ONE line item,
    // so every wall color carried the same name until these were read.
    const byLine = new Map(parsed.offers.map((o) => [o.line, o.room]));
    expect(byLine.get("Walls: HC-172 Revere Pewter - Eggshell")).toBe("Living Room");
    expect(byLine.get("Walls: HC-45 Shaker Beige - Eggshell")).toBe("Dining Room");
    expect(byLine.get("Walls: OC-117 Simply White - Eggshell")).toBe("Kitchen");
    expect(byLine.get("Walls: HC-161 Templeton Gray - Satin")).toBe("Bathroom");
  });

  it("carries 'All rooms' onto the whole-house lines", () => {
    const byLine = new Map(parsed.offers.map((o) => [o.line, o.room]));
    expect(byLine.get("Ceiling: Super White - Flat")).toBe("All rooms");
    expect(byLine.get("Trim: OC-17 White Dove - Semigloss")).toBe("All rooms");
  });

  it("does not let a SURFACE heading become the room", () => {
    // "Ceiling:" on its own names a surface. Treating it as a room would
    // label every following color "Ceiling".
    const p = parseColorNotes("Kitchen:\nCeiling:\nWalls: OC-117 Simply White");
    expect(p.offers[0]?.room).toBe("Kitchen");
  });

  it("keeps the same color in two rooms as two offers", () => {
    // Two rooms, one color, two cans. Deduping on text alone merged them.
    const p = parseColorNotes("Kitchen:\nWalls: OC-117 Simply White\n\nHallway:\nWalls: OC-117 Simply White");
    expect(p.offers).toHaveLength(2);
    expect(p.offers.map((o) => o.room)).toEqual(["Kitchen", "Hallway"]);
  });
});

describe("the remarks survive", () => {
  it("keeps what the customer said, out of the buy list", () => {
    expect(parsed.remarks.some((r) => /accent wall/i.test(r))).toBe(true);
  });
});

describe("a color line is never mistaken for chat", () => {
  it("protects anything shaped like 'Surface: color', however chatty", () => {
    // The asymmetry that matters: showing one line too many costs a glance,
    // dropping a color costs an order.
    expect(isRemark("Trim: OC-17 White Dove, please use the leftover if we can")).toBe(false);
    expect(isRemark("Walls: HC-172 Revere Pewter - Eggshell")).toBe(false);
  });

  it("still calls an actual sentence a remark", () => {
    expect(isRemark("I want different colors for different rooms, so I'm entering it here.")).toBe(true);
    expect(isRemark("Could we do something darker in the hallway?")).toBe(true);
  });

  it("leaves a short bare color line alone", () => {
    // No surface lead, but nothing chatty about it either.
    expect(isRemark("HC-172 Revere Pewter")).toBe(false);
    expect(parseColorNotes("HC-172 Revere Pewter").offers.map((o) => o.line)).toEqual(["HC-172 Revere Pewter"]);
  });
});

describe("the shortest instruction Katie named", () => {
  it("captures 'all ceilings', which is only two words", () => {
    // Her words: "if they state 'all ceilings' or something similar, that
    // isn't captured". It is the reason the qualifier rule cannot simply
    // demand three words to tell an instruction from a quantity.
    const p = parseColorNotes("Ceiling: Super White - Flat (all ceilings)");
    expect(p.offers[0]?.qualifier).toBe("all ceilings");
    expect(p.offers[0]?.line).toBe("Ceiling: Super White - Flat");
  });
});
