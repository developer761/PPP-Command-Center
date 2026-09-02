import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The G703 schedule of values is ONE contract line, plus change orders.
 *
 * Stephanie 2026-09-01: "The inclusions shouldn't show up line by line in the
 * schedule of values, especially if the total price was altered. When we bill,
 * Line 1 is the Original Contract which is the total of the approved proposal
 * items and the lines below line 1 are all the change orders. We don't provide
 * an item specific SOV unless the GC specifically requests it."
 *
 * Two things were wrong, and the second is the one that makes it urgent:
 *
 *  · It published Tomco's internal breakdown to the GC on every application. A
 *    schedule of values is a billing instrument, not a price list, and once the
 *    GC holds the per-item numbers every later negotiation starts from them.
 *
 *  · With a final-price override — which is just how a bid gets negotiated to a
 *    round number — the seed SCALED every line proportionally so the column
 *    footed to the contract sum. The GC received per-item values that were
 *    arithmetic artefacts: matching no proposal, no conversation, no invoice.
 *    That is precisely "especially if the total price was altered".
 *
 * Source-level, because the seed only runs against a real database and the
 * thing being asserted is its SHAPE, not a computed value.
 */
const SRC = readFileSync("lib/commercial/aia/db.ts", "utf8");

describe("the schedule of values", () => {
  it("defaults to a single Original Contract line", () => {
    expect(SRC).toContain('description: "Original Contract"');
    expect(SRC).toMatch(/item_no:\s*"1"/);
  });

  it("only itemises when the application says the GC asked", () => {
    expect(SRC).toMatch(/itemized_sov\s*\}\)\.itemized_sov\s*===\s*true|itemized_sov\s*===\s*true/);
    // The breakdown must sit behind that flag, not run unconditionally.
    const seed = SRC.slice(SRC.indexOf("const seedProposal ="));
    const branch = seed.indexOf("if (itemized)");
    const single = seed.indexOf('description: "Original Contract"');
    expect(branch, "the itemised path should be a branch").toBeGreaterThan(-1);
    expect(single, "the single-line path should exist").toBeGreaterThan(branch);
  });

  it("still appends approved change orders below it", () => {
    // Line 1 is the contract; everything under it is a CO. Losing this would
    // make G703 stop footing to Contract Sum to Date (G702 line 3).
    expect(SRC).toMatch(/item_no:\s*`CO-\$\{String\(co\.co_number\)/);
  });

  it("does not scale the single line — it IS the contract sum", () => {
    // The proportional scaling is what produced the artefact numbers. It may
    // only run on the itemised path, where several lines must foot to a total.
    const seed = SRC.slice(SRC.indexOf("const seedProposal ="));
    const itemisedBranch = seed.indexOf("if (itemized)");
    const scaling = seed.indexOf("contractCents) / rawSum");
    const singleLine = seed.indexOf('description: "Original Contract"');
    // Anchored on the single-line row rather than on `} else {` — the scaling
    // loop contains its own if/else (last row absorbs the rounding), so
    // searching for the next "} else {" found the INNER one and made this
    // assertion fail against correct code.
    expect(scaling, "scaling belongs on the itemised path").toBeGreaterThan(itemisedBranch);
    expect(
      scaling,
      "scaling must sit above the single-line row, i.e. inside the itemised branch"
    ).toBeLessThan(singleLine);
  });
});
