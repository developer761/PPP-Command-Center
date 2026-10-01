import { describe, it, expect } from "vitest";
import { formatOrderSummaryBlock } from "@/lib/supplier-order/builder";

/**
 * Katie, 2026-10-01: she typed "Accent wall Hale Navy" into the color notes,
 * added it to the order, "and was able to add # of gallons, but couldn't
 * add/edit the finish or product line".
 *
 * The builder had said so in as many words — "Hand-typed lines carry no
 * product line by definition" — and printed every one of them as [NOT SET].
 */
const base = { id: "cc-0", label: "Accent wall Hale Navy", qty: 3, unit: "gal" };

describe("a hand-typed color line on the vendor email", () => {
  it("carries the finish when one is given", () => {
    const out = formatOrderSummaryBlock([], null, undefined, [{ ...base, finish: "Eggshell" }]);
    expect(out).toContain("Accent wall Hale Navy · Eggshell");
  });

  it("carries its own product line instead of [NOT SET]", () => {
    const out = formatOrderSummaryBlock([], null, undefined, [
      { ...base, materialType: "Regal Select", finish: "Eggshell" },
    ]);
    expect(out).toContain("Regal Select — Accent wall Hale Navy · Eggshell");
    expect(out).not.toContain("[NOT SET]");
  });

  it("still reads cleanly with neither", () => {
    // Optional on purpose: a color match handed over on a chip has no sheen
    // and no PPP product line to give.
    const out = formatOrderSummaryBlock([], null, undefined, [base]);
    expect(out).toContain("Accent wall Hale Navy");
    expect(out).not.toContain(" · ");
  });

  it("keeps the quantity and the unit the vendor reads", () => {
    const bucket = formatOrderSummaryBlock([], null, undefined, [{ ...base, unit: "bucket", qty: 2 }]);
    // Katie item 8 — "2 x 5 gal", not "2 bucket".
    expect(bucket).toContain("2 x 5 gal");
  });

  it("is not forced to name a product when the rest of the order has one", () => {
    // An order where other lines DO carry a product still prints [NOT SET] for
    // an unanswered hand-typed line, which is the existing rule: a line with no
    // product must not look identical to one that has a product.
    const out = formatOrderSummaryBlock([], null, undefined, [
      { ...base, materialType: "Regal Select" },
      { id: "cc-1", label: "Venetian plaster", qty: 1, unit: "gal" },
    ]);
    expect(out).toContain("Regal Select — Accent wall Hale Navy");
    expect(out).toContain("Venetian plaster");
  });
});
