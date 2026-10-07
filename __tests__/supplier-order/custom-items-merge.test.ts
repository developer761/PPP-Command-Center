import { describe, it, expect } from "vitest";
import { formatOrderSummaryBlock } from "@/lib/supplier-order/builder";

/**
 * Two rooms, one color, ONE vendor line.
 *
 * The room came off these lines on 2026-10-06 (Kate — scope is screen-only,
 * the same rule R4.25 applied to every other line). That left the same color
 * in two rooms printing as two identical lines:
 *
 *     1 gal — Regal Select — Super White · Flat
 *     1 gal — Regal Select — Super White · Flat
 *
 * A vendor cannot tell that from one line duplicated, and shipping one gallon
 * is the likely outcome. The regular rows have had a guard since R4.24; these
 * never did, because until the room came off they were incidentally distinct.
 */

const custom = (over: Record<string, unknown> = {}) => ({
  id: String(Math.random()),
  label: "Super White",
  qty: 1,
  unit: "gal",
  finish: "Flat",
  materialType: "Regal Select",
  ...over,
});

/** The ORDER block only — estimates empty, so every line here is a custom one. */
const block = (items: ReturnType<typeof custom>[]) =>
  formatOrderSummaryBlock([], null, undefined, items as never, undefined);

describe("identical custom lines merge for the vendor", () => {
  it("adds the quantities instead of repeating the line", () => {
    const out = block([custom(), custom()]);
    const lines = out.split("\n").filter((l) => /Super White/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/2 gal/);
  });

  it("keeps genuinely different things apart", () => {
    // Any one of color / finish / product / unit differing is a different
    // thing to buy, and must stay its own line.
    expect(block([custom(), custom({ finish: "Eggshell" })]).split("\n").filter((l) => /Super White/.test(l))).toHaveLength(2);
    expect(block([custom(), custom({ materialType: "Ultra Spec" })]).split("\n").filter((l) => /Super White/.test(l))).toHaveLength(2);
    expect(block([custom(), custom({ unit: "qt" })]).split("\n").filter((l) => /Super White/.test(l))).toHaveLength(2);
    expect(block([custom(), custom({ label: "Hale Navy" })]).split("\n").filter((l) => /gal/.test(l))).toHaveLength(2);
  });

  it("matches on the same spelling regardless of case", () => {
    const lines = block([custom(), custom({ label: "super white", finish: "flat" })])
      .split("\n")
      .filter((l) => /white/i.test(l));
    expect(lines).toHaveLength(1);
  });

  it("clamps the SUM, not each part", () => {
    // Two lines of 60 are 99, not 120 — the clamp is the last thing between a
    // typed number and a vendor's inbox.
    const out = block([custom({ qty: 60 }), custom({ qty: 60 })]);
    expect(out).toMatch(/99 gal/);
    expect(out).not.toMatch(/120 gal/);
  });

  it("still renders a single item unchanged", () => {
    expect(block([custom({ qty: 3 })])).toMatch(/3 gal — Regal Select — Super White · Flat/);
  });
});

describe("the 'no product line' warning tells the truth", () => {
  const WARN = /Paint product line not specified/;

  it("does not fire when the custom lines DO carry a product", () => {
    // On a job where every color came through the Color Notes, `estimates` is
    // empty — so the warning fired on an order whose every line named its
    // product correctly. A warning on a correct order teaches the vendor to
    // ignore the warning that matters.
    expect(block([custom({ materialType: "Regal Select" })])).not.toMatch(WARN);
  });

  it("still fires when nothing anywhere has one", () => {
    expect(block([custom({ materialType: null })])).toMatch(WARN);
  });

  it("marks the unset line rather than hiding it, once anything is set", () => {
    // A row with no product must not look identical to one that has a product.
    const out = block([custom({ materialType: "Regal Select" }), custom({ label: "Hale Navy", materialType: null })]);
    expect(out).toMatch(/\[NOT SET\] — Hale Navy/);
    expect(out).not.toMatch(WARN);
  });
});
