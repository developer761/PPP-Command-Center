import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";
import { dollarsToCents, MAX_CENTS } from "@/lib/commercial/accounting/money";

/**
 * What happens when somebody types something that is not money.
 *
 * `dollarsToCents` returned 0 for anything unparseable. Three of its four
 * callers reject `cents <= 0`, so they were accidentally safe. Two were not:
 *
 *  · the AR row's open amount wrote $0.00 over a real figure;
 *  · and payroll, where it was expensive. A Gusto cost pasted as "N/A" saved
 *    as $0.00, satisfied "a cost has been entered", cleared every blocker, and
 *    let the week post with that person's entire payroll on no job — while the
 *    allocation panel printed "Ties to the $X from Gusto, to the cent."
 *
 * The guard written for exactly this — `if (!Number.isFinite(cents))` — could
 * never fire, because the helper had already turned NaN into 0.
 *
 * 🔴 THIS FILE USED TO ASSERT ON SOURCE TEXT, and that cost a false alarm.
 *
 * The function was module-private in `app/commercial/accounting/page.tsx`, so
 * every test here read the file and matched strings — including counting how
 * many times `cents == null || cents <= 0` appeared and requiring at least
 * three. On 2026-10-15 a real change (a vendor credit is negative, so the cost
 * caller now rejects `=== 0` instead) took that count to two and the suite went
 * red with nothing broken. Meanwhile none of those assertions could have caught
 * the parser actually misreading a number.
 *
 * So the function was exported, and these call it. The one check that genuinely
 * has to read the file — that no caller lets `null` through — stays, written to
 * accept either guard spelling.
 */
const SRC = stripComments(readFileSync("app/commercial/accounting/page.tsx", "utf8"));

describe("money typed by a person", () => {
  it("returns null rather than zero when it is not a number", () => {
    // The exact regression: "N/A" from a spreadsheet becoming $0.00.
    expect(dollarsToCents("N/A")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(undefined)).toBeNull();
    expect(dollarsToCents({})).toBeNull();
    // And zero itself is still zero — distinguishable from "not a number",
    // which is the whole point.
    expect(dollarsToCents("0")).toBe(0);
  });

  it("validates the SHAPE before trusting the value", () => {
    // Number("") is 0 and Number("1e5") is 100000 — neither is money anybody
    // typed into a box.
    expect(dollarsToCents("1e5")).toBeNull();
    expect(dollarsToCents("  ")).toBeNull();
    expect(dollarsToCents("12.5.3")).toBeNull();
  });

  it("reads the money people actually type", () => {
    expect(dollarsToCents("1,250.50")).toBe(125_050);
    expect(dollarsToCents("$1,250.50")).toBe(125_050);
    expect(dollarsToCents(" 1250.5 ")).toBe(125_050);
    expect(dollarsToCents(".50")).toBe(50);
    expect(dollarsToCents("-128.40")).toBe(-12_840);
  });

  it("reads accounting parentheses as negative, not positive", () => {
    // "(500)" is −500 on every statement Mary handles. Reading it as 500 would
    // be worse than rejecting it.
    expect(dollarsToCents("(500)")).toBe(-50_000);
    expect(dollarsToCents("($1,250.50)")).toBe(-125_050);
    // Brackets around an already-negative number must not cancel back out.
    expect(dollarsToCents("(-500)")).toBe(-50_000);
  });

  it("refuses a figure large enough to overflow the column", () => {
    // Otherwise the raw Postgres bigint error reaches the user.
    expect(dollarsToCents("9999999999")).toBeNull();
    expect(dollarsToCents("(9999999999)")).toBeNull();
    // And accepts the largest one that fits, so the limit is a limit and not a
    // blanket refusal of big numbers.
    expect(dollarsToCents(String(MAX_CENTS / 100))).toBe(MAX_CENTS);
  });

  it("every caller treats null as a rejection", () => {
    /*
     * The one assertion that has to read the file: these guards live inside
     * server actions in a page component, which a unit test cannot invoke.
     *
     * Written to accept BOTH spellings on purpose. `<= 0` is right for an AR
     * line and an invoice payment — neither can be negative. `=== 0` is right
     * for a job cost, because a vendor credit or a return IS negative. What
     * must never appear is a caller that checks neither, because `null` does
     * not satisfy `<= 0` and would sail straight through.
     */
    const callSites = SRC.match(/dollarsToCents\(/g) ?? [];
    const guards = SRC.match(/cents == null \|\| cents (<= 0|=== 0|< 0)/g) ?? [];
    expect(callSites.length, "no call sites found — has the helper been renamed?").toBeGreaterThanOrEqual(3);
    expect(guards.length, "a caller of dollarsToCents does not check for null").toBeGreaterThanOrEqual(3);
  });

  it("the AR row leaves the field alone rather than writing zero over it", () => {
    expect(SRC).toContain("dollarsToCents(raw) ?? undefined");
  });
});
