import { describe, it, expect } from "vitest";
import { acceptedBeforeWin } from "@/lib/commercial/proposals/db";

/**
 * An alternate the customer awarded is contract, not a change order.
 *
 * Stephanie 2026-09-01: "Approved alternates can't show up as change orders
 * unless approved AFTER the job is won. Many times the contract is issued with
 * the alternate and it is part of the original contract sum. If the alternate
 * shows up as a change order when billing, the GC is going to get confused and
 * possibly kick it back because they never approved a CO even though the total
 * contract amount is correct."
 *
 * Worth recording how this was found, because the first search missed it. I
 * looked for code that CONVERTS an alternate into a change order. There is
 * none, and I reported it as unreproducible. The mechanism is the inverse:
 * `total_cents` summed only `is_alternate = false`, unconditionally, and that
 * one number is what the AIA ladder, invoicing and every KPI consume. So an
 * awarded alternate was silently dropped from the contract, G702 line 1 came
 * out short by exactly its value, and the only way left to bill it was for a
 * person to raise a CO. The GC then receives a change order for work they
 * approved as part of the original contract — while the total is correct,
 * which is precisely why it confuses rather than simply looking wrong.
 *
 * This function is the cut-off her rule turns on.
 */
describe("was the alternate awarded, or added later?", () => {
  const won = Date.parse("2026-08-17T00:00:00Z");

  it("taken BEFORE the win is contract", () => {
    expect(acceptedBeforeWin("2026-08-10T12:00:00Z", won)).toBe(true);
  });

  it("taken the SAME DAY as the win is contract", () => {
    // An alternate confirmed by email the afternoon the job was awarded is part
    // of the award. `decided_at` is a DATE, so a same-day timestamp is always
    // numerically "after" midnight and would otherwise become a change order.
    expect(acceptedBeforeWin("2026-08-17T16:30:00Z", won)).toBe(true);
  });

  it("taken AFTER the win is a genuine change order", () => {
    expect(acceptedBeforeWin("2026-09-20T09:00:00Z", won)).toBe(false);
  });

  it("a deal that isn't won yet has no 'after' to be after", () => {
    expect(acceptedBeforeWin("2026-08-10T12:00:00Z", null)).toBe(true);
  });

  it("taken with NO timestamp reads as at-the-win", () => {
    // Rows predating migration 174. The safe direction is into the contract:
    // it puts the money where the GC expects it rather than inventing a change
    // order they never approved.
    expect(acceptedBeforeWin(null, won)).toBe(true);
    expect(acceptedBeforeWin(undefined, won)).toBe(true);
  });

  it("an unparseable timestamp does not silently become a change order", () => {
    expect(acceptedBeforeWin("not a date", won)).toBe(true);
  });
});
