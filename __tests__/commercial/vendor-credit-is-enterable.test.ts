/**
 * A vendor credit or a return, typed by a person.
 *
 * Mary, 2026-10-15: *"This applies to a Vendor invoice credit? Return?"* It did
 * not. The guard on every entry path was `amount <= 0`, so a credit could not
 * be entered by hand at all — while:
 *
 *   · `commercial_project_purchases.amount_cents` is a plain bigint with no
 *     constraint against a negative,
 *   · Salesforce records vendor credits as negative transactions, and
 *   · SIXTEEN of them are already in the book, imported — Aboffs and L.I.
 *     Hardware returns totalling -$2,811.85.
 *
 * So the platform stored them, reported them and the importer created them, and
 * the only thing that could not produce one was a person. That became a blocker
 * the moment she stopped entering costs in Salesforce as well.
 *
 * These cover the two pure pieces: what counts as a parseable amount, and what
 * the money parser does with a sign. The server guards are exercised through
 * `addPurchase`/`updatePurchase`, which need a database.
 */
import { describe, expect, it } from "vitest";
import { MAX_CENTS, parseDollarsToCents } from "@/lib/commercial/invoices/format";

describe("the money parser keeps the sign", () => {
  it("reads a credit as a negative number of cents", () => {
    expect(parseDollarsToCents("-128.40")).toBe(-12_840);
    expect(parseDollarsToCents("-$1,250.00")).toBe(-125_000);
    expect(parseDollarsToCents("-7")).toBe(-700);
  });

  it("still reads an ordinary cost", () => {
    expect(parseDollarsToCents("128.40")).toBe(12_840);
    expect(parseDollarsToCents("$1,250.00")).toBe(125_000);
  });

  it("reads the accounting form, with brackets", () => {
    // How a bookkeeper writes a credit. The accounting screen's own parser has
    // always taken it; this one did not, so the same credit was typeable on one
    // screen and refused on the other.
    expect(parseDollarsToCents("(128.40)")).toBe(-12_840);
    expect(parseDollarsToCents("($1,250.00)")).toBe(-125_000);
    // Brackets AND a minus do not cancel out into a positive.
    expect(parseDollarsToCents("(-128.40)")).toBe(-12_840);
  });

  it("refuses what is not an amount", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("credit")).toBeNull();
    expect(parseDollarsToCents("--5")).toBeNull();
    expect(parseDollarsToCents("(5")).toBeNull();
    expect(parseDollarsToCents("5)")).toBeNull();
    expect(parseDollarsToCents("1.234")).toBeNull();
  });

  /*
   * ZERO is the one amount still refused everywhere, and it is refused by the
   * CALLERS rather than here — the parser's job is to read what was typed.
   * Asserted so the distinction is deliberate: `0` parses, and the guards that
   * reject it are testing `=== 0`, not falsiness, because `-0` and `0` both
   * have to be caught.
   */
  it("parses zero, which the callers then refuse", () => {
    expect(parseDollarsToCents("0")).toBe(0);
    expect(parseDollarsToCents("0.00")).toBe(0);
    /*
     * "-0.00" parses to NEGATIVE zero — `Object.is(-0, 0)` is false, so this
     * assertion has to be written the way the guards read it. They compare
     * `amount === 0`, and `-0 === 0` is true, so negative zero IS refused. A
     * guard written as `amount < 0 ? credit : cost` would instead have let it
     * through as a $0 "credit", which is why this is pinned rather than assumed.
     */
    const minusZero = parseDollarsToCents("-0.00");
    expect(minusZero === 0, "negative zero must satisfy the `=== 0` guards").toBe(true);
    expect(Math.round(minusZero as number) === 0).toBe(true);
  });
});

describe("the ceiling, now shared by both parsers", () => {
  /*
   * `dollarsToCents` has always refused a figure big enough to overflow a
   * Postgres bigint, so the raw error never reaches the user.
   * `parseDollarsToCents` did not, and the two were only ever going to be
   * compared after they started agreeing on sign.
   */
  it("refuses an amount that would overflow the column", () => {
    expect(parseDollarsToCents("9999999999")).toBeNull();
    expect(parseDollarsToCents("(9999999999)")).toBeNull();
  });

  it("accepts the largest amount that fits, so the limit is a limit", () => {
    expect(parseDollarsToCents(String(MAX_CENTS / 100))).toBe(MAX_CENTS);
    expect(parseDollarsToCents(`(${MAX_CENTS / 100})`)).toBe(-MAX_CENTS);
  });
});
