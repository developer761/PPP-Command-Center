import { describe, it, expect } from "vitest";
import {
  applyQuantityOverrides,
  summarizeOrder,
  formatOrderQuantity,
  quantityKey,
  type GallonEstimate,
} from "@/lib/supplier-order/estimate-gallons";
import { formatOrderSummaryBlock } from "@/lib/supplier-order/builder";

/**
 * Setting a colour's quantity to zero means "we're not buying this one" —
 * usually because PPP already has it on the shelf.
 *
 * Before this, a zero was indistinguishable from an unsized estimate, so the
 * decision produced the OPPOSITE of what the worker asked for: the vendor was
 * emailed `___ — White Dove OC-17 (PPP to confirm quantity)`, i.e. a request to
 * price paint PPP had explicitly decided not to order, and the builder row
 * nagged "⚠️ set qty" as though the worker had left a field blank. There was no
 * way to remove a colour from an order at all.
 */

function estimate(over: Partial<GallonEstimate> = {}): GallonEstimate {
  return {
    colorId: "c1",
    colorName: "White Dove",
    colorCode: "OC-17",
    finish: "eggshell",
    surfaces: ["Walls"],
    rooms: ["Living Room"],
    placements: [{ surface: "Walls", rooms: ["Living Room"] }],
    totalSqft: 400,
    buckets: 1,
    cans: 2,
    gallons: 7,
    needsMeasurement: false,
    unsized: false,
    manualOnly: false,
    ...over,
  };
}

const key = quantityKey("c1", "eggshell");

describe("excluding a colour from an order", () => {
  it("marks an explicit zero as excluded, not as a gap", () => {
    const [e] = applyQuantityOverrides(
      [estimate()],
      new Map([[key, { buckets: 0, cans: 0, unit: "gal" as const }]])
    );
    expect(e.excluded).toBe(true);
    // Crucially NOT manualOnly — that's what made it render as a
    // "PPP to confirm quantity" placeholder to the vendor.
    expect(e.manualOnly).toBe(false);
    expect(formatOrderQuantity(e)).toBe("not ordering");
  });

  it("does not mark a real quantity as excluded", () => {
    const [e] = applyQuantityOverrides(
      [estimate()],
      new Map([[key, { buckets: 0, cans: 3, unit: "gal" as const }]])
    );
    expect(e.excluded).toBe(false);
    expect(formatOrderQuantity(e)).toBe("3 gal");
  });

  it("leaves an unsized estimate alone — that zero still needs a human", () => {
    // No override at all: the estimator's own zero is a gap, not a decision.
    const [e] = applyQuantityOverrides([estimate({ buckets: 0, cans: 0, gallons: 0, manualOnly: true })], undefined);
    expect(e.excluded).toBeUndefined();
    expect(formatOrderQuantity(e)).toBe("manual entry required");
  });

  it("keeps an excluded colour out of the order total's 'to confirm' count", () => {
    const excluded = applyQuantityOverrides(
      [estimate()],
      new Map([[key, { buckets: 0, cans: 0, unit: "gal" as const }]])
    );
    const t = summarizeOrder(excluded);
    // Neither ordered nor outstanding. Counting it as `reviewColors` would put
    // "(+ 1 to confirm)" on the vendor email's TOTAL line for a colour that
    // isn't on the order.
    expect(t.reviewColors).toBe(0);
    expect(t.sizedColors).toBe(0);
    expect(t.buckets + t.cans + t.quarts).toBe(0);
  });

  it("still counts a genuinely unsized colour as needing confirmation", () => {
    const t = summarizeOrder([estimate({ buckets: 0, cans: 0, gallons: 0, manualOnly: true })]);
    expect(t.reviewColors).toBe(1);
  });
});

/* ── The text a vendor actually reads ─────────────────────────────────────── */

describe("vendor email paint block", () => {
  const stardust = estimate({ colorId: "c2", colorName: "Stardust", colorCode: "2108-40", finish: "satin", rooms: ["Bedroom"] });
  const key2 = quantityKey("c2", "satin");

  it("omits an excluded colour entirely", () => {
    const lines = applyQuantityOverrides(
      [estimate(), stardust],
      new Map([[key, { buckets: 0, cans: 0, unit: "gal" as const }]])
    );
    const block = formatOrderSummaryBlock(lines, null);
    expect(block).toContain("Stardust");
    expect(block).not.toContain("White Dove");
    // And specifically not as the "needs a quantity" placeholder, which asked
    // the vendor to price the very thing PPP had decided not to buy.
    expect(block).not.toContain("TBD");
  });

  it("still shows the placeholder for a colour nobody has sized", () => {
    const block = formatOrderSummaryBlock([estimate({ buckets: 0, cans: 0, gallons: 0, manualOnly: true })], null);
    expect(block).toContain("White Dove");
    // R4.27: "___ (PPP to confirm quantity)" → "TBD". Kate flagged that the
    // underscores were easy to miss on a printed order.
    expect(block).toContain("TBD");
    expect(block).not.toContain("___");
  });

  it("says so plainly when every colour was excluded", () => {
    const lines = applyQuantityOverrides(
      [estimate()],
      new Map([[key, { buckets: 0, cans: 0, unit: "gal" as const }]])
    );
    const block = formatOrderSummaryBlock(lines, null);
    // A header over an empty list reads to a vendor like a truncated message.
    expect(block).toContain("no paint on this order");
  });

  it("does not group under an excluded line's product (R4.32)", () => {
    const overrides = new Map([[key, { buckets: 0, cans: 0, unit: "gal" as const }]]);
    const lines = applyQuantityOverrides([estimate(), stardust], overrides);
    const block = formatOrderSummaryBlock(lines, null, new Map([
      [`c1::eggshell`, "Aura Interior"],   // excluded — must not create a group
      [`c2::satin`, "Regal Select Interior"],
    ]));
    expect(block).toContain("REGAL SELECT INTERIOR");
    expect(block).not.toContain("AURA");
    expect(block).not.toContain("[NOT SET]");
  });
});
