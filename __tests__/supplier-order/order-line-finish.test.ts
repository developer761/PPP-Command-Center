import { describe, it, expect } from "vitest";
import { formatOrderSummaryBlock } from "@/lib/supplier-order/builder";
import type { GallonEstimate } from "@/lib/supplier-order/estimate-gallons";

/**
 * Why the finish stays on vendor order lines.
 *
 * Kate's R4.32 mock-up shows lines WITHOUT it:
 *
 *     REGAL SELECT
 *     1 bucket (×5 gal) — 1421 Bistro Blue
 *
 * Read literally that means dropping the sheen. It shouldn't be, and this test
 * is here so the next person to compare the code against that mock-up sees the
 * reason before "fixing" it.
 *
 * R4.25 asked only for ROOM and SURFACE to come off the lines. Sheen is not
 * placement detail — it's part of the SKU. Two sheens of one colour are two
 * different products, which is exactly why the estimator buckets on
 * `colorId::finish`. So on a job with Bistro Blue eggshell on the walls and
 * semi-gloss on the trim, dropping the finish produces:
 *
 *     3 gal — 1421 Bistro Blue
 *     2 gal — 1421 Bistro Blue
 *
 * Two identical lines, different quantities, no way to tell them apart — an
 * order the vendor cannot fill without ringing back. Her mock-up used a
 * distinct colour per line, so it never surfaced this case.
 */
const est = (o: Partial<GallonEstimate>): GallonEstimate => ({
  colorId: "c1", colorName: "1421 Bistro Blue", colorCode: "1421", finish: "Eggshell",
  surfaces: ["Walls"], rooms: ["Living Room"], placements: [{ surface: "Walls", rooms: ["Living Room"] }],
  totalSqft: 400, buckets: 0, cans: 3, gallons: 3,
  needsMeasurement: false, unsized: false, manualOnly: false, ...o,
});

describe("order lines keep the finish", () => {
  it("distinguishes two sheens of the same colour", () => {
    const block = formatOrderSummaryBlock(
      [
        est({ finish: "Eggshell", cans: 3, gallons: 3 }),
        est({ finish: "Semi-Gloss", cans: 2, gallons: 2, surfaces: ["Trim"] }),
      ],
      "Regal Select"
    );
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.includes("Bistro Blue"));
    expect(lines).toHaveLength(2);
    // The whole point: the two lines must not be identical.
    expect(lines[0]).not.toBe(lines[1]);
    expect(lines.join("\n")).toContain("Eggshell");
    expect(lines.join("\n")).toContain("Semi-Gloss");
  });

  it("still drops room and surface, which is what R4.25 asked for", () => {
    const block = formatOrderSummaryBlock(
      [est({ rooms: ["Living Room", "Bathroom"], surfaces: ["Walls"] })],
      "Regal Select"
    );
    expect(block).not.toContain("Living Room");
    expect(block).not.toContain("Bathroom");
    expect(block).not.toContain("Walls");
    expect(block).toContain("Eggshell");
  });
});
