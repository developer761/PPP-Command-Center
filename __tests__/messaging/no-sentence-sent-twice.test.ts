import { describe, it, expect } from "vitest";
import { renderMessage, withoutRepeatedSentences } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * THE SAME SENTENCE TWICE IN ONE TEXT. 2026-10-16.
 *
 *   "Con gusto. Con gusto le ayudo. Cuál es el proyecto que quiere realizar?"
 *   "Happy to help. Happy to help. What's the project you're looking to get done?"
 *
 * The Spanish one: the duplicate-opener check knew no Spanish "con gusto".
 * The English one: the customer had asked something, so the answerIsOwed
 * carve-out kept a pleasantry the template was about to say word for word.
 * Asserted end to end, through the validator and then the renderer.
 */
const sentences = (s: string) =>
  s.split(/(?<=[.?!])\s+/).map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()).filter(Boolean);

const pair = (freeText: string, customerText: string, language?: "es") => {
  const v = validateAction(
    { intent: "ask_project_details", confidence: 0.97, freeText },
    { customerText, priorIntents: [], knownFields: {} } as never,
  );
  return { v, out: renderMessage({ intent: "ask_project_details", turn: 1, language, freeText: v.ok ? v.action.freeText : freeText, customerText }) };
};

describe("no sentence is sent twice", () => {
  it.each([
    ["Happy to help.", "can you help me?", undefined],
    ["Happy to help.", "I need some painting done", undefined],
    ["Con gusto.", "hola, pueden pintar?", "es" as const],
    ["Con gusto.", "hola, necesito pintar la cocina", "es" as const],
    ["Con mucho gusto.", "hola, necesito pintar la cocina", "es" as const],
  ])("%j for %j", (freeText, customerText, language) => {
    const { out } = pair(freeText, customerText, language);
    const s = sentences(out);
    expect(new Set(s).size, out).toBe(s.length);
    // Nor the same opener twice: "Con gusto. Con gusto le ayudo."
    expect(out, out).not.toMatch(/^(happy to help|con gusto)\b.*\b\1\b/i);
  });

  /**
   * THE CONTROL: an owed ANSWER still goes out in front of the template.
   * The carve-out is narrowed to pleasantries, not removed.
   */
  it("keeps a real answer that shares nothing with the template", () => {
    const { v, out } = pair("Yes, we do cabinets too.", "do you do cabinets?");
    expect(v.ok).toBe(true);
    expect(out).toContain("Yes, we do cabinets too.");
    expect(out).toMatch(/\?$/);
  });

  it("the backstop drops only exact repeats", () => {
    expect(withoutRepeatedSentences("Got it. Got it! What's the address?")).toBe("Got it. What's the address?");
    expect(withoutRepeatedSentences("Got it. Got it, thanks. What's the address?"))
      .toBe("Got it. Got it, thanks. What's the address?");
    expect(withoutRepeatedSentences("")).toBe("");
  });
});
