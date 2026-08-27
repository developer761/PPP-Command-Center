import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_LINES_MAX, formatProductLines } from "@/lib/customer-form/product-lines";

/**
 * Verified against PPP's org on 2026-08-27:
 *   Product_Lines__c — Text Area, length 255, updateable, no near-miss twins.
 *
 * The formatter truncates against a constant, so that constant is a standing
 * assumption about a field somebody else can change in Salesforce. Pinning it
 * here means a change shows up as a failing test rather than as STRING_TOO_LONG
 * on a customer's submit — which would take the colours down too, since they
 * ride the same batch.
 *
 * /api/admin/paint-line-check compares the live field against this same
 * constant and reports a mismatch; this is the offline half of that pair.
 */
describe("the formatter's limit matches the field it writes to", () => {
  it("is the 255 characters the org reported", () => {
    expect(PRODUCT_LINES_MAX).toBe(255);
  });

  it("never emits more than the field can hold", () => {
    const out = formatProductLines({ interior: "A".repeat(500), exterior: "B".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(PRODUCT_LINES_MAX);
  });

  it("has room to spare for every real pairing", () => {
    // Real line names are short; the cap should never actually bite.
    const longest = formatProductLines({ interior: "Ultra Spec Interior Semi Gloss", exterior: "Ultra Spec Exterior Soft Gloss" });
    expect(longest.length).toBeLessThan(PRODUCT_LINES_MAX / 2);
  });

  it("the live checker compares the two rather than printing both", () => {
    // The first version reported `length` and `formatterLimit` side by side and
    // left a human to notice they disagreed.
    const route = readFileSync(join(process.cwd(), "app/api/admin/paint-line-check/route.ts"), "utf8");
    expect(route).toMatch(/target\.length !== PRODUCT_LINES_MAX/);
  });
});
