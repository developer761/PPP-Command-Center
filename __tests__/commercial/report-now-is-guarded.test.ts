import { describe, it, expect } from "vitest";
import { safeNowMs } from "@/lib/commercial/now";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A bad "now" must not take a money page down.
 *
 * Every report builder takes `nowMs = Date.now()` as its FIRST parameter and
 * filters as its second. Swap them — an easy call to get backwards — and
 * `new Date(nowMs).toISOString()` throws "Invalid time value" three frames
 * deep, killing the whole Accounting page rather than degrading.
 *
 * Every caller passes it correctly today. This is here so that stops being the
 * only thing standing between a typo and a blank page, and because the house
 * rule on money is warn, never refuse: a bad clock reading is not a reason to
 * stop showing someone what they are owed.
 */
describe("safeNowMs", () => {
  it("passes a real timestamp straight through", () => {
    const t = 1_787_000_000_000;
    expect(safeNowMs(t, "test")).toBe(t);
    expect(safeNowMs(0, "test")).toBe(0); // the epoch is a real time, not a falsy bug
  });

  it("falls back rather than throwing on anything that isn't a number", () => {
    for (const bad of [{}, "yesterday", null, undefined, NaN, Infinity, [], new Date()]) {
      const got = safeNowMs(bad, "test");
      expect(Number.isFinite(got)).toBe(true);
      // And the value it falls back to must be usable as a date.
      expect(() => new Date(got).toISOString()).not.toThrow();
    }
  });
});

describe("every report builder guards its now", () => {
  // Reads the source rather than a hand-kept list, so a NEW report that takes
  // `nowMs` and forgets the guard fails here.
  const files = readdirSync("lib/commercial/reports")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `lib/commercial/reports/${f}`)
    .concat(["lib/commercial/invoices/statement.ts"]);

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Only files that actually take a caller-supplied clock.
    const takesNow = /\b(nowMs|now)\s*:?\s*(number\s*)?=\s*Date\.now\(\)/.test(src);
    const stamps = /new Date\((nowMs|now)\)\.toISOString\(\)/.test(src);
    if (!takesNow || !stamps) continue;
    it(`${file.split("/").pop()} guards it`, () => {
      expect(
        src.includes("safeNowMs("),
        `${file} takes a caller-supplied "now" and stamps it with toISOString(), but never runs it through safeNowMs — a non-numeric value will throw "Invalid time value" and take the page down.`
      ).toBe(true);
    });
  }
});
