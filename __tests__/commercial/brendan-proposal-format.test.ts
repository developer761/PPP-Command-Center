import { describe, it, expect } from "vitest";
import { scopeSeparator, withFullStop } from "@/lib/commercial/proposals/pdf";

/**
 * Brendan, 2026-09-23, with the approved Tesla CC proposal as the reference:
 *
 *   ours   Prime & Paint Gypsum Walls 2 Coats — Primer + 2 finish coats.
 *   theirs New Gypsum Walls: primer and 2 finish coats.
 *
 * Every line of the proposal Tomco actually sent to Vision General Contractors
 * reads that way — "GWB Wall: Standard preparation, apply 2 finish coats." —
 * so the em-dash was ours, not theirs.
 *
 * Tested here rather than against the rendered PDF on purpose: react-pdf
 * compresses its content streams, so `expect(pdf).toContain("…")` passes
 * whether the text is there or not. This suite has been fooled by exactly that
 * before. The PAGE COUNT and fit of the rendered document are covered by
 * customer-pdfs-are-one-page and every-proposal-pdf-path-fits.
 */
describe("a scope line reads Name: description.", () => {
  it("separates with a colon, not an em-dash", () => {
    expect(scopeSeparator()).toBe(": ");
    expect(scopeSeparator()).not.toContain("—");
  });

  it("finishes the sentence when the description does not", () => {
    expect(withFullStop("primer and 2 finish coats")).toBe("primer and 2 finish coats.");
  });

  it("leaves punctuation that is already there alone", () => {
    for (const ending of [".", "!", "?", ":", ";"]) {
      const text = `standard preparation${ending}`;
      expect(withFullStop(text), `doubled up after "${ending}"`).toBe(text);
    }
  });

  it("does not invent a sentence out of nothing", () => {
    expect(withFullStop("")).toBe("");
    expect(withFullStop("   ")).toBe("");
  });

  it("does not touch the wording — that belongs to whoever wrote the product", () => {
    // "Standard preparation, apply 2 finish coats" is Brendan's phrasing from
    // the approved PDF. Nothing here may reword, recase or re-punctuate it.
    const asWritten = "Standard preparation, apply 1 primer coat and 2 finish coats";
    expect(withFullStop(asWritten)).toBe(`${asWritten}.`);
  });
});
