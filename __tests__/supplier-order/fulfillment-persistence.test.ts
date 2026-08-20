import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeFulfillmentState,
  emptyFulfillmentState,
  fulfillmentIsEmpty,
} from "@/lib/supplier-order/fulfillment-state";

/**
 * R4.33 — fulfilment entries survive going back to the order and returning.
 *
 * Kate named the constraint herself: "the one-way flow you built for Round 3
 * #18 is what stops an address edit from wiping typed quantities, and we don't
 * want that back." Round 3's #20/#22/#23 were all the same shape — one screen
 * writing over another screen's state — so the separation here is structural,
 * not a convention someone has to remember:
 *
 *   /build        writes `payload`      and never `fulfillment`
 *   /fulfillment  writes `fulfillment`  and never `payload`
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the two order routes write disjoint columns", () => {
  const build = codeOnly(read("app/api/admin/supplier-order/build/route.ts"));
  const fulfil = codeOnly(read("app/api/admin/supplier-order/fulfillment/route.ts"));

  it("the fulfilment route never writes the order payload", () => {
    // Anything that would put `payload` into an update/upsert body.
    expect(fulfil).not.toMatch(/\bpayload\s*[,:]/);
    expect(fulfil).toMatch(/\.update\(\{\s*fulfillment/);
  });

  it("the build route never writes the fulfilment slice", () => {
    expect(build).not.toMatch(/\bfulfillment\s*[,:]/);
  });

  it("the fulfilment route cannot CREATE a build row", () => {
    // An upsert here would insert a row whose `payload` is empty — which is
    // exactly "fulfilment wiped the order", the bug being avoided.
    expect(fulfil).not.toContain(".upsert(");
    expect(fulfil).toContain(".update(");
  });
});

describe("normalizeFulfillmentState", () => {
  it("round-trips what the admin typed", () => {
    const typed = {
      method: "pickup" as const,
      pickupLocation: "Aboffs Huntington",
      deliveryAddr: { street: "1 Main St", city: "Huntington", state: "NY", postalCode: "11743" },
      useCustomAddress: true,
      instructions: "Ask for Dave at the back door",
      requiredBy: "2026-09-01",
      contactPhone: "(347) 476-6555",
    };
    expect(normalizeFulfillmentState(typed)).toEqual(typed);
  });

  it("degrades instead of throwing on anything unexpected", () => {
    // This JSON is written by one build and read by every later one.
    expect(normalizeFulfillmentState(null)).toEqual(emptyFulfillmentState());
    expect(normalizeFulfillmentState("nope")).toEqual(emptyFulfillmentState());
    expect(normalizeFulfillmentState({ deliveryAddr: "not an object" }).deliveryAddr).toEqual({
      street: "", city: "", state: "", postalCode: "",
    });
    // An unknown method must not leak through as a delivery/pickup value.
    expect(normalizeFulfillmentState({ method: "teleport" }).method).toBe("delivery");
    // Truthy-but-not-true must not become a checked box.
    expect(normalizeFulfillmentState({ useCustomAddress: "yes" }).useCustomAddress).toBe(false);
  });

  it("trims a stored timestamp back to a date", () => {
    expect(normalizeFulfillmentState({ requiredBy: "2026-09-01T00:00:00Z" }).requiredBy).toBe("2026-09-01");
  });

  it("recognises an untouched form so mounting doesn't write a row", () => {
    expect(fulfillmentIsEmpty(emptyFulfillmentState())).toBe(true);
    expect(fulfillmentIsEmpty({ ...emptyFulfillmentState(), instructions: "x" })).toBe(false);
    expect(fulfillmentIsEmpty({ ...emptyFulfillmentState(), method: "pickup" })).toBe(false);
  });
});
