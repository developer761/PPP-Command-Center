import { describe, it, expect } from "vitest";
import { DEFAULT_SUPPLIER_TEMPLATE, render } from "@/lib/supplier-order/templates";

/**
 * A real order Kate sent went to the vendor as:
 *
 *   "PPP Order PPP-WO00316046 — (unknown customer) (WO 00316046)"
 *
 * When the work order has no Account resolved, the builder substituted the
 * literal string "(unknown customer)" — into the SUBJECT the supplier reads,
 * and into "Customer:" in the body. The same file already states the rule two
 * fields up, for the PPP Account line: when unset, omit the line entirely,
 * because nobody should ever be shown a placeholder.
 *
 * It also fed customer_first, so any greeting using it would have read
 * "Hi (unknown,".
 *
 * Asserts the RENDERED email, not the template string — the bug was in what
 * went out, and a template can look right while the substitution does not.
 */
describe("a supplier email never advertises a missing customer", () => {
  const base = {
    po_number: "00316046",
    wo_number: "00316046",
    ppp_brand: "Precision Painting Plus",
    required_by_date: "Sep 5",
    fulfillment_block: "Pickup",
    ppp_account_number: "",
    supplier_name: "Vendor - Kate Test",
  };

  it("omits the customer clause from the subject when unknown", () => {
    const out = render(DEFAULT_SUPPLIER_TEMPLATE.subject, { ...base, customer_name: "" });
    expect(out).not.toMatch(/unknown/i);
    expect(out).not.toMatch(/—\s*\(/);
    // Katie item 15/16 (2026-09-08) made the PO the bare work-order number and
    // dropped the trailing "(WO …)", which said the same thing twice.
    expect(out).toContain(base.po_number);
  });

  it("still shows the customer when there IS one", () => {
    const out = render(DEFAULT_SUPPLIER_TEMPLATE.subject, { ...base, customer_name: "Jane Doe" });
    expect(out).toContain("— Jane Doe");
  });

  it("drops the whole 'Customer:' line rather than printing it blank", () => {
    const out = render(DEFAULT_SUPPLIER_TEMPLATE.intro, { ...base, customer_name: "" });
    expect(out).not.toMatch(/Customer:/);
    expect(out).not.toMatch(/This order is for/);
    expect(out).not.toMatch(/unknown/i);
    // the job is still identifiable — by its PO, which IS the work order number
    expect(out).toContain(`PO Number: ${base.po_number}`);
  });

  it("keeps the Customer line when a name exists", () => {
    const out = render(DEFAULT_SUPPLIER_TEMPLATE.intro, { ...base, customer_name: "Jane Doe" });
    // Katie item 17: a sentence, not a labelled field.
    expect(out).toContain("This order is for Jane Doe.");
  });

  it("the placeholder string is gone from the builder entirely", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
    // Comments may describe the old behaviour; code must not produce it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/"\(unknown customer\)"/);
  });
});
