import { describe, it, expect } from "vitest";
import { validateAction, checkRapport } from "@/lib/messaging/agent-output";

const act = (freeText: string) => ({ intent: "acknowledge", freeText, confidence: 0.99, reasoning: "" });

/**
 * Kate's tone rules, which were previously in the prompt and nowhere else.
 *
 * These drop the rapport rather than refusing the turn: an em dash is not
 * worth escalating a customer to a human over, and the template still carries
 * the message.
 */
describe("tone rules are enforced, but proportionately", () => {
  it("drops rapport that asks a second question", () => {
    const res = validateAction(act("Got it. What room is it?"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.action.freeText).toBeUndefined();
      expect(res.droppedRapport).toMatch(/second question/);
    }
  });

  it("keeps the action, so the conversation still moves", () => {
    const res = validateAction(act("Got it. What room is it?"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action.intent).toBe("acknowledge");
  });

  it.each([
    ["Got it — thanks", "em dash"],
    ["Okay...", "ellipsis"],
    ["Got it (for now)", "parentheses"],
    ["Yep, got it", '"Yep"'],
    ["Thanks for letting me know", "Thanks for letting me know"],
  ])("drops %j", (text) => {
    const res = validateAction(act(text));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action.freeText).toBeUndefined();
  });

  it("keeps rapport that follows the rules", () => {
    const res = validateAction(act("Okay, got it."));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.action.freeText).toBe("Okay, got it.");
      expect(res.droppedRapport).toBeUndefined();
    }
  });

  it("drops rapport that echoes the customer back at them", () => {
    const customerText = "I want the exterior of my house painted, cedar shake cleaned and scraped";
    const res = validateAction(
      act("Okay, the exterior of my house painted, got it."),
      { customerText }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.droppedRapport).toMatch(/repeats the customer/);
  });

  it("does not call a short overlap an echo", () => {
    const res = checkRapport("Okay, got it.", "I need the kitchen done, got it sorted soon");
    expect(res.ok).toBe(true);
  });

  it("still hard-refuses a price rather than merely dropping it", () => {
    const res = validateAction({ intent: "acknowledge", freeText: "It'll be about $500", confidence: 0.99, reasoning: "" });
    // A price is a promise we cannot keep. That is not a style problem.
    expect(res.ok).toBe(false);
  });

  it("has nothing to drop when there is no rapport", () => {
    const res = validateAction({ intent: "acknowledge", freeText: "", confidence: 0.99, reasoning: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.droppedRapport).toBeUndefined();
  });
});
