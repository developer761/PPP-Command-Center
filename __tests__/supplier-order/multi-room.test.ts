/**
 * Every string in this file is REAL `WorkOrderLineItem.Description` text,
 * sampled read-only from the live org on 2026-10-09 (1,000 rows, 794 with a
 * description). Invented examples would have passed the first version of this
 * detector, which called 24.6% of line items multi-room and was wrong most of
 * the time. The live text is what found all three defects.
 *
 * Trimmed for length, never reworded.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MULTI_ROOM_ALERT,
  multiRoomLines,
  roomsNamedIn,
} from "@/lib/supplier-order/multi-room";

describe("rooms named in a real scope note", () => {
  /* ── Genuinely several rooms ──────────────────────────────────────── */

  it("catches a scope that walks through the house", () => {
    const rooms = roomsNamedIn("Paint walls Dining room Kitchen- ceiling included Stairway Upstairs hallway");
    expect(rooms).toEqual(expect.arrayContaining(["dining room", "kitchen", "stairway", "hallway"]));
    expect(rooms.length).toBeGreaterThanOrEqual(4);
  });

  it("catches rooms listed with their dimensions", () => {
    // Verbatim, leading typo and all — the live record really does start
    // "iving room", so "living room" does NOT match here and should not. Two
    // rooms is still two rooms.
    const rooms = roomsNamedIn("iving room first floor 14x11x10 Hallway 9x8x10, and bathroom 6x5x9 (only treat damaged areas)");
    expect(rooms).toEqual(expect.arrayContaining(["hallway", "bathroom"]));
    expect(rooms.length).toBeGreaterThanOrEqual(2);
  });

  it("catches an 'includes X' afterthought", () => {
    // The second room arrives in the last four words of the note.
    const rooms = roomsNamedIn("Laundry Room: - prep, oil prime and paint all wood stained trim; doors (both sides), base, casings, jambs, and windows. - includes bathroom.");
    expect(rooms).toEqual(expect.arrayContaining(["laundry room", "bathroom"]));
  });

  it("catches a route through three spaces", () => {
    const rooms = roomsNamedIn("Prep, spot prime and paint walls, ceiling, trim, doors and closets in the foyer and hallway to bedroom");
    expect(rooms).toEqual(expect.arrayContaining(["foyer", "hallway"]));
    expect(rooms.length).toBeGreaterThanOrEqual(2);
  });

  it("catches a whole-house line item", () => {
    const rooms = roomsNamedIn("Interior Painting: master bedroom, kitchen, bathroom, hall, living room, dining room, family room, bedroom, laundry");
    expect(rooms.length).toBeGreaterThanOrEqual(6);
  });

  /* ── One room, however the text reads ─────────────────────────────── */

  it("does not count 'bath' inside 'bathroom'", () => {
    // The substring bug: two hits, one room.
    expect(roomsNamedIn("Paint walls, ceilings, trim, doors and closets in: Bathroom")).toEqual(["bathroom"]);
  });

  it("does not count 'hall' inside 'hallway'", () => {
    expect(roomsNamedIn("Paint walls, ceilings, trim, doors and closets in: Hallway")).toEqual(["hallway"]);
  });

  it("does not read PPP's own surface list as rooms", () => {
    // "doors and closets" is the template's SURFACE list. Counting "closets"
    // made every single-room line item in the org look like two.
    expect(roomsNamedIn("Paint walls, ceilings, trim, doors and closets in: Kitchen (including prime walls first, Painting frame, doors and inside of cabinets)")).toEqual(["kitchen"]);
  });

  it("treats a slashed compound name as one room", () => {
    expect(roomsNamedIn("Paint walls, ceilings, trim, doors and closets in: Foyer/entryway (including spindles and banister)")).toEqual(["foyer"]);
  });

  it("treats a KNOWN compound pair as one space", () => {
    expect(roomsNamedIn("- 3rd Floor Stairwell hallway")).toEqual(["stairwell"]);
  });

  it("does NOT collapse a list just because it is space-separated", () => {
    // The near-miss: a general "touching words are one room" rule read this
    // four-room list as three. Spacing cannot tell a compound from a list.
    const rooms = roomsNamedIn("Paint walls Dining room Kitchen- ceiling included Stairway Upstairs hallway");
    expect(rooms).toContain("dining room");
    expect(rooms).toContain("kitchen");
  });

  it("ignores a room named only to say where the work is", () => {
    // The work is in the office. The kitchen is how you find the wall.
    const rooms = roomsNamedIn("Prep, spot prime and paint walls, ceiling, trim and doors in the office One accent wall to be painted in the office (note - it's the wall with the transom from the kitchen)");
    expect(rooms).toEqual(["office"]);
  });

  it("is empty for a note that names no room at all", () => {
    expect(roomsNamedIn("- prep, oil prime and paint all wood stained trim; doors (both sides), base, casings, jambs, and windows.")).toEqual([]);
  });

  it("is empty for nothing", () => {
    expect(roomsNamedIn(null)).toEqual([]);
    expect(roomsNamedIn(undefined)).toEqual([]);
    expect(roomsNamedIn("   ")).toEqual([]);
  });
});

describe("which line items get the alert", () => {
  const line = (over: Partial<{ id: string; room: string; notes: string | null; productFamily: string | null }> = {}) => ({
    id: "l1",
    room: "Main",
    notes: "Paint walls Dining room Kitchen- ceiling included Stairway Upstairs hallway",
    productFamily: "Interior Painting",
    ...over,
  });

  it("flags an interior line whose notes name several rooms", () => {
    const hits = multiRoomLines([line()]);
    expect(hits).toHaveLength(1);
    expect(hits[0].room).toBe("Main");
    expect(hits[0].rooms.length).toBeGreaterThanOrEqual(4);
  });

  it("does not flag exterior work", () => {
    // "garage" and "entry" are parts of a house's outside, not rooms being
    // painted — the last false-positive class after the text rules.
    expect(
      multiRoomLines([line({ productFamily: "Exterior Painting", notes: "Exterior: pressure wash garage and entry" })])
    ).toEqual([]);
  });

  it("still checks a line with no product family rather than skipping it", () => {
    // A missing field must not make a warning quietly disappear.
    expect(multiRoomLines([line({ productFamily: null })])).toHaveLength(1);
    expect(multiRoomLines([{ id: "x", room: "Main", notes: line().notes }])).toHaveLength(1);
  });

  it("leaves single-room lines alone", () => {
    expect(multiRoomLines([line({ notes: "Paint walls, ceilings, trim, doors and closets in: Bathroom" })])).toEqual([]);
  });

  it("uses Kate's wording exactly", () => {
    expect(MULTI_ROOM_ALERT).toBe(
      "Multiple rooms detected on one line item. Confirm with customer before ordering"
    );
  });

  it("stays quiet on an empty work order", () => {
    expect(multiRoomLines([])).toEqual([]);
  });
});

/**
 * The seam: a detector nothing renders is a function nobody calls. Checked
 * because that exact thing has happened here before — the kitchen "please
 * review" note was computed and shown nowhere for four days.
 */
describe("the alert actually reaches the order screen", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

  it("renders the hits in the order builder", () => {
    const src = strip(read("components/order-builder-view.tsx"));
    expect(src).toContain("multiRoomLines(sourceLines)");
    expect(src).toMatch(/multiRoomHits\.length > 0 &&/);
    expect(src).toContain("{MULTI_ROOM_ALERT}");
  });

  it("sits ABOVE the buy list, not inside the collapsed source panel", () => {
    // The source panel is collapsed by default on a phone (Kate's own
    // request), so an alert rendered inside it would be invisible to her.
    const src = strip(read("components/order-builder-view.tsx"));
    const alertAt = src.indexOf("multiRoomHits.length > 0");
    const buyListAt = src.indexOf("ref={buyListRef}");
    const sourcePanelAt = src.indexOf('id="source-lines-list"');
    expect(alertAt).toBeGreaterThan(-1);
    expect(buyListAt).toBeGreaterThan(-1);
    expect(alertAt).toBeLessThan(buyListAt);
    expect(alertAt).toBeGreaterThan(sourcePanelAt);
  });

  it("carries productFamily through so exterior work is skipped", () => {
    // Without this the detector sees undefined, checks anyway, and flags
    // exterior jobs for a "garage" and an "entry".
    expect(strip(read("lib/materials/order-page-data.ts"))).toMatch(
      /productFamily:\s*li\.raw\.productFamily\s*\?\?\s*null/
    );
    expect(strip(read("components/order-builder-view.tsx"))).toMatch(/productFamily\?:\s*string \| null/);
  });
});

/**
 * These cover the rules that an ablation over 711 live rows proved are
 * load-bearing. The consume rule was worth 24 false positives and NOTHING in
 * the first version of this file caught its removal — the tests passed with it
 * deleted, which is the "check that cannot fail" trap.
 */
describe("the rules that are actually doing the work", () => {
  it("counts 'master bedroom' once, not as master bedroom AND bedroom", () => {
    // \b does not save you here: the space before "bedroom" IS a word
    // boundary, so the shorter name matches inside the longer one. Deleting
    // the consume step turns 96 flagged lines into 120.
    expect(roomsNamedIn("Paint ceiling in master bedroom")).toEqual(["master bedroom"]);
    expect(roomsNamedIn("prep the primary bedroom")).toEqual(["primary bedroom"]);
    expect(roomsNamedIn("living room only")).toEqual(["living room"]);
  });

  it("still sees a second, genuinely different bedroom", () => {
    const rooms = roomsNamedIn("paint master bedroom and bedroom 2");
    expect(rooms).toContain("master bedroom");
    expect(rooms).toContain("bedroom");
    expect(rooms).toHaveLength(2);
  });
});

describe("a room named so it is NOT painted", () => {
  it("ignores an explicitly excluded room", () => {
    // Real text: the apartment is painted, the office is carved out of it.
    // Counting it turned one scope into two rooms.
    const rooms = roomsNamedIn("Paint entire apartment . Walls, ceiling, baseboard, doors, inside closet. Do not paint office walls .");
    expect(rooms).not.toContain("office");
  });

  it("ignores an 'excludes X' carve-out", () => {
    expect(roomsNamedIn("Paint the kitchen throughout, excludes pantry")).toEqual(["kitchen"]);
  });

  it("still counts a room that is merely mentioned after a full stop", () => {
    const rooms = roomsNamedIn("Paint the kitchen. Also paint the office.");
    expect(rooms).toContain("kitchen");
    expect(rooms).toContain("office");
  });
});
