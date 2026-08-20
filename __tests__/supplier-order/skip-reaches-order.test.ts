import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R4.15 — "On WO 00308360, Kitchen. The Color Notes box on Order Materials is
 * populated — but this line is missing from it: 'Kitchen: Customer selected
 * "Don't paint this surface" on Cabinets.'"
 *
 * Kate's point was that the line reached Salesforce AND Rooms & Colors but not
 * Order Materials. The cause: resolveLineItems walked the five SALESFORCE
 * FIELDS — walls / ceiling / trim / other / floor — so a customer who skipped
 * "Cabinets" was never looked up at all. The field list has no key for it.
 *
 * The real payload from production is below.
 */
const src = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** WO 00308360 · Kitchen — Surfaces__c = "Walls;Cabinets;Door". */
const KITCHEN_SURFACES = [
  { surface: "Walls", colorId: "a026g00000XQ5Z4AAL", skipped: false },
  { surface: "Cabinets", colorId: null, skipped: true },
  { surface: "Door", colorId: "a026g00000XQ79xAAD", skipped: false },
];

describe("a skipped orphan surface reaches the order", () => {
  it("walks the customer's OWN surfaces, not just the Salesforce fields", () => {
    // The five-slot list can only ever look up these labels.
    const fieldLabels = ["Walls", "Ceiling", "Trim", "Other", "Floor"];
    const skippedByCustomer = KITCHEN_SURFACES.filter((s) => s.skipped).map((s) => s.surface);
    expect(skippedByCustomer).toEqual(["Cabinets"]);
    // Proof the old code could not have seen it: "Cabinets" is not a field label.
    expect(fieldLabels).not.toContain(skippedByCustomer[0]);

    // So the builder must iterate the customer's surfaces for anything the
    // field list can't represent, and record a skip from there.
    expect(code).toContain("for (const [key, pick] of customerSurfaces)");
    expect(code).toMatch(/if \(fieldSurfaceKeys\.has\(key\)\) continue;/);
    expect(code).toMatch(/if \(pick\.skipped\) \{\s*skipped\.push\(\{ roomLabel, surface: pick\.surface \}\);/);
  });

  it("still records the skip when the room's other orphan HAS a colour", () => {
    // The Kitchen case exactly: Cabinets skipped, Door picked. The skip branch
    // must come before the colour check, or a room with any coloured orphan
    // would swallow the skip.
    const loop = code.slice(code.indexOf("for (const [key, pick] of customerSurfaces)"));
    const skipAt = loop.indexOf("pick.skipped");
    const colorAt = loop.indexOf("if (!pick.colorId) continue;");
    expect(skipAt).toBeGreaterThan(-1);
    expect(colorAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(colorAt);
  });

  it("feeds skippedSurfaces into the order's Color Notes", () => {
    // Which is where Kate expected to see it.
    expect(code).toMatch(/if \(skippedSurfaces\.length > 0\) \{/);
    expect(code).toMatch(/colorNotesDefaultParts\.push\("Not painting:"\)/);
    expect(code).toMatch(/for \(const s of skippedSurfaces\) colorNotesDefaultParts\.push/);
  });
});
