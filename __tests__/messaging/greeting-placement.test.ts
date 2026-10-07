import { describe, it, expect } from "vitest";
import { applyDisclosure, DISCLOSURE_OUT_OF_HOURS, DISCLOSURE_OUT_OF_HOURS_ES } from "@/lib/messaging/disclosure";
import { renderMessage } from "@/lib/messaging/render";

/**
 * THE DISCLOSURE GOES IN FRONT, SO THE BODY NO LONGER OPENS THE MESSAGE.
 *
 * Seen in the sandbox against production, Spanish first contact:
 *
 *   "Soy un asistente de inteligencia artificial, pero puedo tomar los
 *    detalles de su proyecto y pasarlos cuando abramos. Hola! El precio lo
 *    define el estimador…"
 *
 * A greeting a sentence and a half in reads as two messages stitched
 * together. The renderer drops rapport that is ONLY a greeting, but it cannot
 * drop one that leads a sentence worth keeping, and it does not know a
 * disclosure is about to be prepended.
 */
describe("a greeting does not end up in the middle", () => {
  it("drops it from a Spanish body", () => {
    const out = applyDisclosure("prefix", "Hola! El precio lo define el estimador.", true);
    expect(out.startsWith(DISCLOSURE_OUT_OF_HOURS_ES)).toBe(true);
    expect(out).not.toMatch(/\.\s+Hola/i);
    expect(out).toContain("El precio lo define el estimador.");
  });

  it("drops it from an English body", () => {
    const out = applyDisclosure("prefix", "Hi there! Pricing comes from the estimator.", false);
    expect(out.startsWith(DISCLOSURE_OUT_OF_HOURS)).toBe(true);
    expect(out).not.toMatch(/\.\s+Hi there/i);
    expect(out).toContain("Pricing comes from the estimator.");
  });

  it("never takes a greeting from inside a sentence", () => {
    const body = "The estimator will say hello when they arrive.";
    expect(applyDisclosure("prefix", body, false)).toContain(body);
  });

  it("still sends the disclosure when the body was only a greeting", () => {
    expect(applyDisclosure("prefix", "Hola!", true)).toBe(DISCLOSURE_OUT_OF_HOURS_ES);
  });

  it("and the renderer still drops a bare Spanish greeting on its own", () => {
    const out = renderMessage({ intent: "acknowledge", language: "es", freeText: "Hola!", turn: 0 });
    expect(out.toLowerCase().startsWith("hola")).toBe(false);
    expect(out.trim()).not.toBe("");
  });
});

/**
 * The customer may write "¡Hola!" even though we never do. Asserted here
 * rather than in the regex's own file, because that file is read by the test
 * that keeps Mac and Jasmine's no-inverted-punctuation rule, and a literal
 * character in it would fail that test for a good reason.
 */
it("strips a greeting the customer wrote with inverted punctuation", () => {
  const out = applyDisclosure("prefix", "¡Hola! El precio lo define el estimador.", true);
  expect(out).not.toMatch(/Hola/i);
  expect(out).toContain("El precio lo define el estimador.");
});
