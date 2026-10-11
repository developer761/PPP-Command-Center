/**
 * Product_Lines__c derived from the ORDER, not from an AM's up-front guess.
 *
 * Kate 2026-10-09 asked for the product-line selector to come off the AMs'
 * Internal Entry form. It could not just be deleted: that selector was the
 * ONLY writer of Product_Lines__c, which is her own R6.2 field. These cover
 * the replacement source, so the selector can be removed without the
 * writeback going quiet.
 */
import { describe, expect, it } from "vitest";
import {
  formatProductLines,
  parseProductLines,
  productLinesFromOrder,
  PRODUCT_LINES_MAX,
} from "@/lib/customer-form/product-lines";
import { isExteriorProduct } from "@/lib/customer-form/material-types";

const from = (o: Parameters<typeof productLinesFromOrder>[0]) =>
  productLinesFromOrder(o, isExteriorProduct);

describe("deriving the lines from what was ordered", () => {
  it("splits the per-color picks by side", () => {
    const got = from({
      materialTypeOverrides: { a: "Regal Select", b: "Ultra Spec Exterior" },
    });
    expect(got.interior).toEqual(["Regal Select"]);
    expect(got.exterior).toEqual(["Ultra Spec Exterior"]);
  });

  it("records a job that mixes two interior lines", () => {
    // The case Katie deleted the single selector FOR: one control cannot
    // speak for a job running Ultra Spec and Regal. The old single-string
    // write recorded whichever one the AM happened to pick.
    const got = from({
      materialTypeOverrides: { a: "Regal Select", b: "Ultra Spec Interior" },
    });
    expect(formatProductLines(got)).toBe("Interior: Regal Select, Ultra Spec Interior");
  });

  it("de-duplicates the same line used on many colors", () => {
    const got = from({
      materialTypeOverrides: { a: "Regal Select", b: "Regal Select", c: "regal select" },
    });
    expect(formatProductLines(got)).toBe("Interior: Regal Select");
  });

  it("still writes Kate's original shape for the ordinary job", () => {
    // Real picklist values. Bare "Woodluxe" is not one — the org holds
    // "Woodluxe Water-Based Stain" — and a test using a value PPP cannot
    // order would prove nothing about a field PPP reads.
    const got = from({
      materialTypeOverrides: { a: "Regal Select", b: "Woodluxe Water-Based Stain" },
    });
    expect(formatProductLines(got)).toBe(
      "Interior: Regal Select | Exterior: Woodluxe Water-Based Stain"
    );
  });

  it("classifies by the picklist, not by the word looking exterior-ish", () => {
    // isExteriorProduct is the authority. A value that is not in the org at
    // all falls to interior rather than being guessed at, which is why the
    // test above uses the full stain name.
    const got = from({ materialTypeOverrides: { a: "Ultra Spec Exterior" } });
    expect(got.exterior).toEqual(["Ultra Spec Exterior"]);
    expect(got.interior).toEqual([]);
  });

  it("falls back to mainMaterialType for an order saved before per-color pickers", () => {
    expect(formatProductLines(from({ mainMaterialType: "Regal Select" })))
      .toBe("Interior: Regal Select");
  });

  it("writes NOTHING when the order carries no line", () => {
    // "" is the caller's signal not to write. Blanking a value nobody chose
    // to clear would lose a real answer.
    expect(formatProductLines(from({ materialTypeOverrides: {} }))).toBe("");
    expect(formatProductLines(from({}))).toBe("");
    expect(formatProductLines(from({ materialTypeOverrides: { a: "  " } }))).toBe("");
  });

  it("round-trips through the stored text", () => {
    const got = from({
      materialTypeOverrides: { a: "Regal Select", b: "Woodluxe Water-Based Stain" },
    });
    const back = parseProductLines(formatProductLines(got));
    expect(back.interior).toBe("Regal Select");
    expect(back.exterior).toBe("Woodluxe Water-Based Stain");
  });

  it("truncates rather than letting Salesforce reject the write", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`c${i}`] = `Regal Select ${i}`;
    const out = formatProductLines(from({ materialTypeOverrides: many }));
    expect(out.length).toBeLessThanOrEqual(PRODUCT_LINES_MAX);
  });
});
