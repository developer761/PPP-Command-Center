/**
 * Kate 2026-10-09 closed the default-product-line question herself: "the guys
 * will have to select a line on each color no matter what so I actually don't
 * think a default selector will save them time … If we want to display the
 * chosen line from the Quote to remind them, that may be a good idea!"
 *
 * So this is a REMINDER, and these tests exist to keep it one. The failure
 * mode is somebody later wiring it into the picker as a convenience, which
 * recreates the "Use Default" control Katie had removed on 2026-09-08 — one
 * value speaking for a job that mixes Ultra Spec and Regal.
 */
/**
 * NOTE ON stripComments: it removes block comments FIRST and never tries to
 * match the `{ ... }` of a JSX comment.
 *
 * The obvious pattern — /\{\s*\/\*[\s\S]*?\*\/\s*\}/ — is a trap. It
 * requires the closing `*\/` to be followed by `}`, so when the nearest one
 * is not, it keeps scanning for a later `*\/` that is and swallows every line
 * in between. Measured on components/order-builder-view.tsx: 118 characters
 * of real code gone, silently, which is how a source assertion passes for a
 * reason that has nothing to do with the code under test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the quoted product line is shown, not applied", () => {
  const view = () => strip(read("components/order-builder-view.tsx"));

  it("renders it on the order screen", () => {
    expect(view()).toMatch(/\{quotedProductLine && \(/);
    expect(view()).toContain("Quoted product line:");
  });

  it("comes from the estimator's field, read-only", () => {
    // MaterialType__c is the estimator's answer from the quote. The hub reads
    // it and writes Product_Lines__c instead (Kate R6.2) — never this.
    const page = strip(read("app/dashboard/materials/[woId]/order/page.tsx"));
    expect(page).toMatch(/const quotedLine = paintLineFromValue\(data\.job\.wo\.materialType\)/);
    expect(page).toMatch(/quotedProductLine=\{quotedLine && quotedLine !== "Other" \? quotedLine : null\}/);
  });

  it("NEVER feeds a picker — it is a reminder, not a default", () => {
    const src = view();
    // No onChange/setter may consume it, and it must not seed any state.
    expect(src).not.toMatch(/useState\([^)]*quotedProductLine/);
    expect(src).not.toMatch(/setMaterialType\w*\(\s*quotedProductLine/);
    expect(src).not.toMatch(/value=\{\s*quotedProductLine/);
    expect(src).not.toMatch(/\?\?\s*quotedProductLine/);
    expect(src).not.toMatch(/quotedProductLine\s*\|\|\s*\w+\s*\}/);
  });

  it("does not disturb the per-color requirement", () => {
    // The "Product line required" refusal must still exist and still be
    // driven by the per-color selections, not by the quote.
    const src = view();
    expect(src).toMatch(/productLineError/);
    expect(src).toMatch(/totalNeedProductLine/);
  });
});

describe("what the reminder refuses to say", () => {
  it("does not print 'Other' as a quoted line", () => {
    // 29 of the 109 work orders that carry MaterialType__c hold "Other".
    // "Quoted product line: Other" is noise occupying a reminder's place.
    const page = strip(read("app/dashboard/materials/[woId]/order/page.tsx"));
    expect(page).toMatch(/quotedLine !== "Other"/);
  });
});
