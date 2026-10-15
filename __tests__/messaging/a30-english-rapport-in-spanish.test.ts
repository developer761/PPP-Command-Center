import { describe, it, expect } from "vitest";
import { renderMessage, readsAsEnglish } from "@/lib/messaging/render";

/**
 * A30 — "Reply in the customer's language."
 *
 * The templates are translated; the model's own sentence is not guaranteed
 * to be. Rendering a Spanish conversation produced:
 *
 *   "Happy to help with that. Dónde queda la propiedad?"
 *
 * which is the bug that STARTED A30 with its halves swapped — "Hola! Con
 * gusto le ayudo. What are you looking to have painted?"
 *
 * Dropped rather than refused: the template already says the substantive
 * thing, so losing the rapport costs a pleasantry while refusing the turn
 * would cost the whole reply.
 */
describe("A30 — English rapport does not ride a Spanish template", () => {
  it.each([
    "Happy to help with that.",
    "Got it, thank you.",
    "Sure thing, no problem!",
    "I'll get that sorted for you.",
  ])("drops %j from a Spanish reply", (rapport) => {
    const out = renderMessage({ intent: "ask_address", turn: 1, language: "es", freeText: rapport } as never);
    expect(out).not.toContain(rapport);
    // the template still goes out — this costs a pleasantry, never the reply
    expect(out).toMatch(/propiedad|direcci/i);
  });

  /**
   * THE HALF THAT MATTERS MORE. A positive English test is used precisely so
   * a short Spanish pleasantry is never mistaken for English and deleted —
   * that would leave the reply colder than it should be, to fix a bug that
   * was not there.
   */
  it.each([
    "Con gusto.",
    "Perfecto.",
    "Listo.",
    "Entendido, gracias.",
    "Claro que sí.",
    "Muy bien.",
  ])("keeps the Spanish pleasantry %j", (rapport) => {
    const out = renderMessage({ intent: "ask_address", turn: 1, language: "es", freeText: rapport } as never);
    expect(out).toContain(rapport);
  });

  it("leaves an English conversation completely alone", () => {
    const out = renderMessage({ intent: "ask_address", turn: 1, freeText: "Happy to help with that." } as never);
    expect(out).toContain("Happy to help with that.");
  });
});

describe("readsAsEnglish only answers true when it can prove it", () => {
  it.each(["Happy to help with that.", "Got it, thank you.", "I'll check on that for you."])(
    "%j is English", (t) => expect(readsAsEnglish(t)).toBe(true));

  it.each(["Con gusto.", "Perfecto.", "Muy bien.", "Entendido, gracias.", ""])(
    "%j is not provably English", (t) => expect(readsAsEnglish(t)).toBe(false));
});
