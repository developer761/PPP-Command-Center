import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

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
 * never fire, because the helper had already turned NaN into 0. A check that
 * cannot fail in the case it was written for.
 *
 * The function is module-private, so this pins the SHAPE of the contract at
 * the seam instead: null for not-money, and every caller treating null as a
 * rejection. Comments are stripped first — tests here have matched their own
 * prose five times.
 */
const SRC = stripComments(readFileSync("app/commercial/accounting/page.tsx", "utf8"));

function body(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf("\n}", start));
}

describe("money typed by a person", () => {
  it("returns null rather than zero when it is not a number", () => {
    const fn = body("dollarsToCents");
    expect(fn).toContain("number | null");
    // The exact regression: a bare `return 0` for unparseable input.
    expect(fn).not.toMatch(/if\s*\(!Number\.isFinite\(n\)\)\s*return 0;/);
    expect(fn).toContain("return null");
  });

  it("validates the SHAPE before trusting the value", () => {
    // Number("") is 0 and Number("1e5") is 100000 — neither is money anybody
    // typed into a box.
    expect(body("dollarsToCents")).toMatch(/\\d\*\\\.\?\\d\+|\\d\+/);
  });

  it("reads accounting parentheses as negative, not positive", () => {
    // "(500)" is −500 on every statement Mary handles. Reading it as 500 would
    // be worse than rejecting it.
    expect(body("dollarsToCents")).toContain("negative");
  });

  it("refuses a figure large enough to overflow the column", () => {
    // Otherwise the raw Postgres bigint error reaches the user.
    expect(body("dollarsToCents")).toContain("1_000_000_000_00");
  });

  it("every caller treats null as a rejection", () => {
    // Three guarded on `cents <= 0`, which null does NOT satisfy — so each one
    // had to learn about null or it would sail straight through.
    const guards = SRC.match(/cents == null \|\| cents <= 0/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    expect(SRC).toContain("cents == null || cents < 0");
  });

  it("the AR row leaves the field alone rather than writing zero over it", () => {
    expect(SRC).toContain("dollarsToCents(raw) ?? undefined");
  });
});
