import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The print stylesheet, read as the CSS it emits.
 *
 * Karan 2026-09-16: "could we also have a Print / PDF button so we can send in
 * a clean PDF format." Clean means the report and nothing else, so what this
 * pins is the two rules that make that true — every selector scoped to the
 * sheet's id, and the hide/flatten split.
 *
 * It asserts on the STRING the component builds, because that string is the
 * artifact: a rule that loses its `#${id}` prefix would hide or restyle parts
 * of the app shell on every page that prints, and nothing else here would
 * notice. Break either rule and this goes red.
 */

const SRC = readFileSync("components/commercial/print-sheet.tsx", "utf8");

/** The template body of PrintSheetStyles, with `${id}` resolved. */
function css(id = "accounting-sheet"): string {
  const open = SRC.indexOf("<style>{`");
  const close = SRC.indexOf("`}</style>", open);
  expect(open, "PrintSheetStyles still has an inline <style> template").toBeGreaterThan(-1);
  return SRC.slice(open + "<style>{`".length, close).replaceAll("${id}", id);
}

describe("the printed sheet is the report and nothing else", () => {
  it("scopes every rule inside @media print to the sheet, or to print-only bits", () => {
    const body = css();
    // Strip block comments FIRST. A prose line inside one can contain a brace
    // ("the tempting rule is `button, select { display: none }`") and a
    // line-prefix filter reads it as a selector — which is how this test
    // failed on its first run against code that was correct.
    const inPrint = body.slice(body.indexOf("@media print")).replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = inPrint
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("{"))
      .filter((l) => !l.startsWith("@media") && !l.startsWith("@page"));

    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf("{")).trim();
      const scoped =
        selector.includes("#accounting-sheet") ||
        // The two deliberate exceptions: blanking the page, and the header
        // that exists only on paper.
        selector === "body" ||
        selector === "body *" ||
        selector.includes("[data-print-only]");
      expect(scoped, `unscoped print rule would affect the whole app: "${selector}"`).toBe(true);
    }
  });

  it("hides whole screen-only blocks but keeps the data readable", () => {
    const body = css();
    // A block tagged screen-only goes.
    expect(body).toMatch(/\[data-print-hide\]\s*\{\s*display:\s*none/);
    // A control inside the data is stripped, NOT hidden — on the ledger the
    // deposited state IS a button, and hiding it prints an empty column.
    const controls = body.slice(body.indexOf("input:not("));
    expect(controls).toContain("border: none");
    expect(controls.slice(0, controls.indexOf("}"))).not.toContain("display: none");
  });

  it("a table that scrolls sideways on screen prints in full", () => {
    expect(css()).toContain("overflow: visible");
  });

  it("repeats table headers across pages and avoids splitting a row", () => {
    const body = css();
    expect(body).toContain("thead { display: table-header-group; }");
    expect(body).toMatch(/tr\s*\{\s*break-inside:\s*avoid/);
  });
});
