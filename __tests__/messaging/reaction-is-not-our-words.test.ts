import { describe, it, expect } from "vitest";
import { validateAction, checkTone } from "@/lib/messaging/agent-output";
import { normalizeInbound } from "@/lib/messaging/inbound-normalize";

/**
 * AN IPHONE REACTION QUOTES US BACK, AND TWO RULES READ IT AS THE CUSTOMER.
 *
 * inbound.description is written for the MODEL: 'The customer liked the
 * message: "Sure thing. What are you hoping to have painted?"'. Both of the
 * rule checks that judge what the customer SAID were reading that string.
 *
 * Found in the simulator by clicking Liked on the bot's own question: the
 * turn came back rejected as question_left_unanswered, because the question
 * mark it found was ours.
 *
 * Same trap that put `Liked "..."` into inquiry_scope this morning, one layer
 * up. normalizeInbound already has the answer — text is null for a bare
 * reaction, because they said nothing of their own.
 */
const LIKED = 'Liked "Sure thing. What are you hoping to have painted?"';
const ownWords = (raw: string) => normalizeInbound(raw, 0).text ?? "";

describe("a reaction is not the customer asking us something", () => {
  it("leaves no question outstanding, because they asked nothing", () => {
    const r = validateAction(
      { intent: "ask_project_details", confidence: 0.85, freeText: "" },
      { knownFields: {}, stage: 0, priorIntents: ["ask_project_details"], customerText: ownWords(LIKED) },
    );
    expect(r.ok).toBe(true);
  });

  it("still catches a real question answered only with the next question", () => {
    const r = validateAction(
      { intent: "ask_project_details", confidence: 0.85, freeText: "" },
      { knownFields: {}, stage: 0, priorIntents: ["ask_project_details"], customerText: "do you do cabinets?" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("question_left_unanswered");
  });

  /**
   * And the other half: rephrasing a question after a reaction is what the
   * reaction guidance ASKS the model to do, so it must not read as echoing
   * the customer's own words back at them.
   */
  it("does not read our own quoted sentence as an echo of the customer", () => {
    // No question mark: rapport carrying one is refused by the one-ask rule
    // before the echo check is ever reached, so this isolates the echo.
    const rapport = "Sure thing. What are you hoping to have painted.";
    expect(checkTone(rapport, ownWords(LIKED)).ok).toBe(true);
    // Given the DESCRIPTION, which is what it used to get, our own sentence
    // inside their reaction reads as the customer's words.
    const onDescription = checkTone(rapport, normalizeInbound(LIKED, 0).description);
    expect(onDescription.ok).toBe(false);
    if (!onDescription.ok) expect(onDescription.why).toMatch(/repeats the customer/);
  });
});
