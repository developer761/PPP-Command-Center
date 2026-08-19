import { describe, it, expect } from "vitest";
import { formatOrderSummaryBlock } from "@/lib/supplier-order/builder";
import { type GallonEstimate } from "@/lib/supplier-order/estimate-gallons";

/**
 * R4.30 — group the order lines under their paint line instead of prefixing
 * each row "[Regal Select] ". Colors with no line and no order default collect
 * under [NOT SET], because a row with no product line used to be visually
 * identical to a row the header covered — silently unaccounted for.
 *
 * Also asserts R4.23 (no rooms/surfaces), R4.24 (no doubled code), R4.25 (TBD)
 * and R4.28 (no TOTAL), since they all render through this one function and
 * the whole point is what a vendor actually reads.
 */
function est(over: Partial<GallonEstimate> = {}): GallonEstimate {
  return {
    colorId: "c1", colorName: "1421 Bistro Blue", colorCode: "1421", finish: "Eggshell",
    surfaces: ["Walls"], rooms: ["Living Room"], totalSqft: 400,
    placements: [{ surface: "Walls", rooms: ["Living Room"] }],
    buckets: 1, cans: 0, gallons: 5,
    needsMeasurement: false, unsized: false, manualOnly: false, ...over,
  };
}

describe("vendor order block", () => {
  it("groups by product line, with [NOT SET] last", () => {
    const estimates = [
      est(),
      est({ colorId: "c2", colorName: "HC-14 Princeton Gold", colorCode: "HC-14", finish: "Eggshell", buckets: 0, cans: 3, gallons: 3 }),
      est({ colorId: "c3", colorName: "Super White", colorCode: "Super White", finish: "Semi-Gloss", buckets: 0, cans: 1, gallons: 1 }),
    ];
    const block = formatOrderSummaryBlock(estimates, null, new Map([
      ["c1::Eggshell", "Regal Select"],
      ["c2::Eggshell", "Aura"],
      // c3 deliberately unset
    ]));
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

    expect(lines).toContain("REGAL SELECT");
    expect(lines).toContain("AURA");
    expect(lines).toContain("[NOT SET]");
    // [NOT SET] is the exception, so it sorts last however the groups appear.
    expect(lines.indexOf("[NOT SET]")).toBe(Math.max(
      lines.indexOf("REGAL SELECT"), lines.indexOf("AURA"), lines.indexOf("[NOT SET]")
    ));
    // Each colour sits under its own heading.
    expect(lines[lines.indexOf("REGAL SELECT") + 1]).toContain("1421 Bistro Blue");
    expect(lines[lines.indexOf("AURA") + 1]).toContain("HC-14 Princeton Gold");
    expect(lines[lines.indexOf("[NOT SET]") + 1]).toContain("Super White");
    // R4.30 replaced the per-row prefix.
    expect(block).not.toContain("[Regal Select]");
  });

  it("stays a flat list when no product line is set anywhere", () => {
    // Grouping an order nobody set a line on would render one "[NOT SET]"
    // heading over the whole list — noise, not information.
    const block = formatOrderSummaryBlock([est()], null);
    expect(block).not.toContain("[NOT SET]");
    expect(block).toContain("1421 Bistro Blue");
  });

  it("doesn't print the colour code twice (R4.24)", () => {
    const block = formatOrderSummaryBlock([
      est(),
      est({ colorId: "c3", colorName: "Super White", colorCode: "Super White", finish: "Semi-Gloss" }),
    ], null);
    expect(block).not.toContain("1421 Bistro Blue 1421");
    expect(block).not.toContain("Super White Super White");
  });

  it("keeps the finish but drops room and surface (R4.23)", () => {
    const block = formatOrderSummaryBlock([est({ rooms: ["Living Room", "Bathroom"], surfaces: ["Walls"] })], null);
    expect(block).not.toContain("Living Room");
    expect(block).not.toContain("Bathroom");
    expect(block).not.toContain("Walls");
    // Finish is load-bearing — two sheens of one colour are two SKUs, and the
    // estimator buckets on colorId::finish precisely for that reason.
    expect(block).toContain("Eggshell");
  });

  it("has no TOTAL line (R4.28)", () => {
    const block = formatOrderSummaryBlock([est()], null);
    expect(block).not.toContain("TOTAL");
    expect(block).not.toContain("─────");
  });
});
