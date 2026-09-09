import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySurface } from "@/lib/supplier-order/estimate-gallons";

/**
 * Karan 2026-09-09: "for each color we should have it here so we don't keep
 * having to scroll up" — then, precisely: ceiling square footage, wall surface
 * area, trim linear feet.
 *
 * The room's measurements lived only in the Salesforce panel at the top of the
 * page, so checking a quantity meant scrolling away from the quantity. They now
 * sit on the line itself, and each surface shows the measure that actually
 * governs it: showing floor area against a trim line is noise, because trim is
 * priced off the perimeter.
 */
const view = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");

describe("each surface shows the measure that governs it", () => {
  it("classifies the surfaces PPP actually writes", () => {
    expect(classifySurface("Ceiling")).toBe("ceiling");
    expect(classifySurface("Walls")).toBe("walls");
    expect(classifySurface("Trim")).toBe("trim");
    expect(classifySurface("Door")).toBe("trim");
    expect(classifySurface("Floor")).toBe("floor");
  });

  it("ceiling and floor read square feet", () => {
    expect(view).toMatch(/kind === "ceiling" \|\| kind === "floor"/);
    expect(view).toMatch(/src\.sqft\.toLocaleString\(\)\} sq ft/);
  });

  it("walls read WALL surface area, not floor", () => {
    expect(view).toMatch(/kind === "walls"/);
    expect(view).toMatch(/src\.wallSqft\.toLocaleString\(\)\} sq ft wall/);
  });

  it("trim reads linear feet", () => {
    expect(view).toMatch(/kind === "trim"/);
    expect(view).toMatch(/lin ft/);
  });

  it("a derived perimeter says so", () => {
    // Perimeter is sparse in Salesforce; the estimator falls back to
    // 4*sqrt(floor). Showing that silently would present a guess as a
    // measurement — the reader is checking a quantity against it.
    expect(view).toMatch(/\(derived\)/);
    expect(view).toMatch(/4 \* Math\.sqrt\(src\.sqft\)/);
  });

  it("the line carries perimeter at all", () => {
    // Without it, trim had nothing to show but floor area — the noise this
    // change exists to remove.
    expect(view).toMatch(/perimeterLf: number;/);
    const data = readFileSync(join(process.cwd(), "lib/materials/order-page-data.ts"), "utf8");
    expect(data).toMatch(/perimeterLf: li\.raw\.perimeter/);
  });

  it("nothing is shown when a room has no measurements", () => {
    // An empty label is worse than none — it reads as a missing number rather
    // than a room nobody measured.
    expect(view).toMatch(/if \(measures\.length === 0\) return null;/);
  });
});
