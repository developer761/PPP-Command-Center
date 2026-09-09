import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyFulfillmentState } from "@/lib/supplier-order/fulfillment-state";

/**
 * Katie item 10: "marked off for delivery (default for delivery)."
 * Karan, 2026-09-09: "on fulfilment, we want to default to deliver to customer.
 * I told you this and you still didn't do it."
 *
 * He was right. I verified `fulfillmentMethod: "delivery"` in the order BUILDER
 * and reported item 10 as already done. That is the method on step 1. The
 * FULFILMENT step then ran an effect that switched itself to Pickup whenever
 * the supplier was pickup-default OR the delivery address was in the five
 * boroughs — and most of PPP's work is in the boroughs, so the page opened on
 * Pickup for the majority of orders.
 *
 * The lesson is in the check, not the fix: "a default exists somewhere in the
 * flow" is not "the screen opens on it".
 */
const view = readFileSync(
  join(process.cwd(), "components/order-fulfillment-view.tsx"),
  "utf8"
);
const code = view.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("fulfilment opens on delivery to the customer", () => {
  it("the stored default is delivery", () => {
    expect(emptyFulfillmentState().method).toBe("delivery");
  });

  it("...and to the customer's own address, not a typed one", () => {
    expect(emptyFulfillmentState().useCustomAddress).toBe(false);
  });

  it("NOTHING switches the toggle on its own", () => {
    // The whole defect. An effect calling setFulfillment("pickup") is the
    // thing that made the default a lie.
    expect(code).not.toMatch(/setFulfillment\("pickup"\)[\s\S]{0,40}\}, \[/);
    const effects = code.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) {
      expect(e, "an effect must not choose the fulfilment method").not.toMatch(
        /setFulfillment\(/
      );
    }
  });

  it("a pickup-only vendor is a hint, not a switch", () => {
    // Switching for the worker made the decision invisible and sent orders as
    // pickup nobody had chosen. Saying so leaves the choice with them.
    expect(code).toMatch(/const suggestPickup = Boolean\(/);
    expect(view).toMatch(/usually a pickup/);
  });

  it("the worker can still choose pickup", () => {
    // Removing the auto-switch must not remove the option.
    expect(code).toMatch(/setFulfillment\("pickup"\)/);
    expect(view).toMatch(/Pickup at supplier/);
  });
});
