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

/**
 * THE BOT HAS NO CALENDAR.
 *
 * Found in the sandbox 2026-10-01. The customer named a scope and an address
 * and no time whatsoever; the bot replied "I'll check the calendar for that
 * time. Got it! Is 12 Marchmont Ave, 11530 the correct address?"
 *
 * That sentence carries no digit and no time-shaped token, so TIME_COMMITMENT
 * and the numeric backstop both let it through — and this very string was
 * already sitting in rapport-stacking.test.ts as an example of ACCEPTABLE
 * rapport, which is how it survived a suite that otherwise checks this area
 * hard.
 *
 * Dropped, not refused: the template underneath asks the right question.
 */
describe("rapport may not claim the bot is checking a calendar", () => {
  const dropped = (freeText: string, intent = "acknowledge") => {
    const res = validateAction({ intent, freeText, confidence: 0.99, reasoning: "" } as never);
    expect(res.ok, freeText).toBe(true);
    return res.ok ? res.droppedRapport : undefined;
  };

  it.each([
    "I'll check the calendar for that time.",
    "Let me check the calendar.",
    "I'll check our schedule and get back to you.",
    "Let me check availability.",
    "Let me see what we have available.",
    "I'll look at the books.",
    "I'll pull up the schedule.",
    "Let me see when we can fit you in.",
    "I'll get you on the books.",
  ])("drops %j", (text) => {
    expect(dropped(text)).toMatch(/calendar/);
  });

  /**
   * THE HALF THAT MATTERS MORE. A guard this shape earns its keep by what it
   * leaves alone — rapport is most of the warmth in a reply, and a check that
   * eats honest sentences gets switched off.
   */
  it.each([
    "Got it!",
    "Happy to help with that.",
    "I'll pass this along to the estimator.",
    "Let me check with the office on that.",
    "I'll make sure someone picks this up.",
    "Thanks for bearing with me.",
    "That sounds like a decent sized job.",
  ])("leaves %j alone", (text) => {
    expect(dropped(text)).toBeUndefined();
  });

  it("exempts checking_availability, whose approved template says exactly this", () => {
    expect(dropped("One moment while I check availability.", "checking_availability")).toBeUndefined();
  });

  it("keeps the turn, so a good lead is not handed to a person over a sentence", () => {
    const res = validateAction(
      { intent: "confirm_address", freeText: "I'll check the calendar for that time.", confidence: 0.9, reasoning: "" } as never,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.action.freeText).toBeUndefined();
  });
});
