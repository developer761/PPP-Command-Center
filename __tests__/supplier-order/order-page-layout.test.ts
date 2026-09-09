import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Katie item 9, 2026-09-08: "line items should be all the way at the top for
 * material ordering and don't have it as a dropdown."
 *
 * This REVERSES R4.18, which had collapsed the panel and moved it last on the
 * grounds that an expanded copy of the source data pushed the buy-list off the
 * first screen. The office's answer is that the source data is what they check
 * the buy-list against, so it belongs before the numbers. Pinned here because a
 * future tidy-up would otherwise "restore" the collapse as an improvement.
 */
const src = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("the order page opens on the Salesforce line items", () => {
  it("the panel is not a dropdown", () => {
    expect(code).not.toMatch(/<details/);
    expect(code).not.toMatch(/<summary/);
  });

  it("it sits ABOVE the vendor picker", () => {
    const lineItems = code.indexOf("Line items on this WO");
    const vendor = code.indexOf(">Vendor<");
    expect(lineItems).toBeGreaterThan(-1);
    expect(vendor).toBeGreaterThan(-1);
    expect(lineItems, "line items must come first in the document").toBeLessThan(vendor);
  });

  it("and above the buy-list it is checked against", () => {
    const lineItems = code.indexOf("Line items on this WO");
    // The per-color quantity rows — the thing an estimator verifies.
    const buyList = code.indexOf("formatOrderQuantity(e)");
    expect(buyList).toBeGreaterThan(-1);
    expect(lineItems).toBeLessThan(buyList);
  });
});
