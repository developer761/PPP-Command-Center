import { describe, it, expect } from "vitest";
import { normalizeBuildPayload } from "@/lib/supplier-order/build-state";

/**
 * Does a custom color item SURVIVE being saved?
 *
 * `normalizeBuildPayload` runs on the write path (the build route normalizes
 * before the upsert) and again on the read. It rebuilds each item field by
 * field rather than spreading it, so a field added to `CustomColorItem` and
 * not added there is dropped on the way to the database — silently, while the
 * screen still shows it from the in-memory payload.
 *
 * Three had been lost that way:
 *   · `finish` and `materialType`  — Katie, 2026-10-01
 *   · `scope`                      — Kate, 2026-10-06
 *
 * The `finish` one was a REGRESSION. Before the 10-06 split the sheen rode to
 * the vendor inside the flattened label; separating it moved it into a field
 * this function threw away, so the counter got a color with no sheen at all.
 *
 * 448 supplier-order tests were green and tsc was clean throughout: every one
 * of them stopped at the in-memory payload. This crosses the seam.
 */

const item = {
  id: "cc-0-super-white",
  label: "Super White",
  qty: 3,
  unit: "gal",
  finish: "Flat",
  materialType: "Ultra Spec",
  scope: "Ceiling — All rooms",
};

/** What a save actually does: normalize in, store, read, normalize out. */
function roundTrip(payload: unknown) {
  const written = normalizeBuildPayload(payload);
  const stored = JSON.parse(JSON.stringify(written)); // the DB column
  return normalizeBuildPayload(stored);
}

describe("a custom color item survives the round trip", () => {
  it("keeps the sheen, the product line and the scope", () => {
    const out = roundTrip({ customColorItems: [item] });
    expect(out.customColorItems).toHaveLength(1);
    expect(out.customColorItems[0]).toMatchObject({
      label: "Super White",
      qty: 3,
      unit: "gal",
      finish: "Flat",
      materialType: "Ultra Spec",
      scope: "Ceiling — All rooms",
    });
  });

  it("the vendor line still carries the sheen after a save", () => {
    // The actual consequence, rebuilt the way builder.ts formats it. Before the
    // fix this read "3 gal — [NOT SET] — Super White".
    const c = roundTrip({ customColorItems: [item] }).customColorItems[0];
    const emailed = `${c.qty} ${c.unit} — ${c.materialType} — ${c.label}${c.finish ? ` · ${c.finish}` : ""}`;
    expect(emailed).toBe("3 gal — Ultra Spec — Super White · Flat");
  });

  it("an item the estimator left blank stays blank, not empty-string", () => {
    // null, not "" — an empty string reads as "they cleared it" and would show
    // as an answered product line that prints [NOT SET] to the vendor.
    const out = roundTrip({ customColorItems: [{ id: "x", label: "Color Match: Behr 56", qty: 1, unit: "gal" }] });
    expect(out.customColorItems[0].finish).toBeNull();
    expect(out.customColorItems[0].materialType).toBeNull();
    expect(out.customColorItems[0].scope).toBeNull();
  });

  it("still clamps and defaults everything it did before", () => {
    const out = roundTrip({
      customColorItems: [{ id: "y", label: "  Stain  ", qty: 9999, unit: "  ", finish: "   " }],
    });
    expect(out.customColorItems[0]).toMatchObject({ label: "Stain", qty: 99, unit: "gal", finish: null });
  });

  it("carries every field the component can set", () => {
    // The guard that makes the next added field fail here instead of silently
    // vanishing: whatever the item carries in, the same keys come out.
    const out = roundTrip({ customColorItems: [item] });
    expect(Object.keys(out.customColorItems[0]).sort()).toEqual(Object.keys(item).sort());
  });
});
