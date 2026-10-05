import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { scopeBlockLines } from "@/lib/commercial/proposals/scope-blocks";

/**
 * The Qualifications box takes a pasted LIST.
 *
 * Stephanie 2026-10-05: "I didn't add them as exclusions because I didn't want
 * to type them in or copy them in all individually ... so I added them as
 * qualifications and removed all of the exclusions completely to avoid there
 * being 2 sections ... With that, I am still not seeing bullets on the
 * qualifications I did add."
 *
 * That box printed as a single paragraph — it was the one place on the document
 * that could not make a list. A note of several lines is now bullets; a
 * one-line note stays prose, which is what every existing proposal holds and
 * none of them may change shape.
 *
 * The splitting rule is `scopeBlockLines`, shared with the scope blocks, so one
 * rule governs every pasted list here.
 */
describe("a multi-line qualifications note", () => {
  const HER_PASTE = [
    "Work to be completed during normal business hours",
    "Roof surfaces",
    "Copper gutters, flashing, and copper components",
    "Any work not specifically listed under inclusions",
  ].join("\n");

  it("becomes one line per bullet", () => {
    expect(scopeBlockLines(HER_PASTE)).toHaveLength(4);
    expect(scopeBlockLines(HER_PASTE)[0]).toBe("Work to be completed during normal business hours");
  });

  it("strips bullets she pasted, because the page draws its own", () => {
    // Times has no ● glyph — a typed one prints as "Ï".
    expect(scopeBlockLines("● Roof surfaces\n• Decking")).toEqual(["Roof surfaces", "Decking"]);
  });

  it("leaves a one-line note as a single line, so prose stays prose", () => {
    const prose = "Price assumes one mobilisation and clear, unobstructed access.";
    expect(scopeBlockLines(prose)).toEqual([prose]);
  });
});

/**
 * And the renderer actually branches on it. Asserted on the source because the
 * rendered PDF cannot be read back — react-pdf compresses its streams — and
 * because the risk here is a branch that was never wired, not its layout.
 */
describe("the renderer prints those bullets", () => {
  /*
   * COMMENTS STRIPPED FIRST. This codebase has already shipped a test that
   * matched its own docblock and passed over broken code; the comment above
   * this branch quotes Stephanie and would satisfy a naive grep on its own.
   */
  const src = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("bullets a multi-line note instead of printing one paragraph", () => {
    expect(src).toMatch(/noteLines\.length > 1/);
    // The drawn dot, not a typed glyph.
    expect(src).toMatch(/noteLines\.map[\s\S]{0,220}styles\.bulletDot/);
  });

  it("still has the single-line paragraph branch", () => {
    expect(src).toMatch(/\) : note \? \(/);
  });
});
