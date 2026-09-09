import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Karan 2026-09-09, reading a real order: "living room walls and accent walls
 * should always be close to each other… try using logic to always organize
 * this page."
 *
 * The buy-list came out in whatever order the estimator's colour map produced.
 * On his order the Living Room's WALLS were the first line and its ACCENT WALL
 * was the ninth — the two lines you most need to read together, because the
 * accent is a second colour over part of the wall the first line prices.
 */
const view = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");

/**
 * SURFACE_ORDER is READ OUT OF the shipped component, not mirrored here.
 *
 * A copied array is not a test of anything: the first version declared its own
 * and passed happily with the real one reordered so the accent wall came
 * BEFORE the walls — the exact arrangement this file exists to prevent.
 */
const SURFACE_ORDER: string[] = JSON.parse(
  (/const SURFACE_ORDER = (\[[^\]]*\])/.exec(view)?.[1] ?? "[]").replace(/'/g, '"')
);
const surfaceRank = (label: string) => {
  const l = label.toLowerCase();
  const i = SURFACE_ORDER.findIndex((k) => l.includes(k));
  return i === -1 ? SURFACE_ORDER.length : i;
};

describe("the buy-list walks the job in a readable order", () => {
  it("an accent wall follows the walls it sits on", () => {
    expect(surfaceRank("Accent Wall")).toBeGreaterThan(surfaceRank("Walls"));
    // ...and nothing else comes between them.
    expect(surfaceRank("Accent Wall") - surfaceRank("Walls")).toBe(1);
  });

  it("a room is painted walls, ceiling, trim — then its fittings", () => {
    const order = ["Walls", "Ceiling", "Trim", "Door", "Cabinets", "Floor"].map(surfaceRank);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("an unknown surface sorts last rather than first", () => {
    // Sorting it to 0 would put a surface nobody recognises above the walls.
    expect(surfaceRank("Radiator")).toBe(SURFACE_ORDER.length);
  });

  it("rooms follow the Salesforce order, so both panels read the same way", () => {
    expect(view).toMatch(/sourceLines\.map\(\(l, i\) => \[l\.room, i\]\)/);
  });

  it("a colour spanning rooms sorts with its FIRST room", () => {
    // Trim across the living room and bathroom belongs with the living room,
    // not floating between the two.
    expect(view).toMatch(/Math\.min\(\.\.\.ranks\)/);
  });

  it("the list stays flat — order, not headings", () => {
    // Karan asked for order, not more chrome; the room name is already on
    // every line, so a heading per room would repeat it.
    //
    // Asserted as "the estimates render is a single flat map", NOT by looking
    // for <h2> near it: the first version sliced 15,000 characters that
    // happened to include the Vendor section's own headings and failed on
    // those. It was measuring the wrong region, not finding a real problem.
    expect(view).toMatch(/\{estimates\.map\(\(e\) => \{/);
    // no grouping pass between the sort and the render
    expect(view).not.toMatch(/groupBy\(estimates|estimatesByRoom/);
  });
});

describe("a door does not report the room's perimeter", () => {
  it("shows nothing rather than a number that means something else", () => {
    // classifySurface groups doors with trim, which is right for the gallon
    // maths and wrong here: "Door — Kitchen · 48 lin ft" reads as the door's
    // size and is actually the length of the walls around it.
    expect(view).toMatch(/\/door\|window\|cabinet\/i\.test\(surface\)/);
  });

  it("real trim still shows linear feet", () => {
    expect(view).toMatch(/src\.perimeterLf > 0/);
    expect(view).toMatch(/lin ft/);
  });
});
