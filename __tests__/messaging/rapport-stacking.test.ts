import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";
import { validateAction, BARE_ACKNOWLEDGEMENT } from "@/lib/messaging/agent-output";

/**
 * TWO BUGS FOUND BY READING THE MESSAGES, NOT BY A TEST.
 *
 * Walking ten conversations through the real pipeline and reading what came
 * out produced these, in the first run:
 *
 *   "Got it. Got it. And what's the zip code there?"
 *   "Great, thank you. Perfect, you're all set."
 *   "Sorry about that. Apologies, I did not mean to make this harder."
 *
 * Half the templates open by acknowledging something, and so does most
 * rapport, so the two stacked. Every existing test passed throughout, because
 * each asserted that the right words were PRESENT — and they were, twice.
 *
 * The same root caused the second bug. A29 asked whether a direct question
 * was answered and accepted any rapport at all, so "Do you do cabinets as
 * well?" answered with "Got it. Where's the property located?" passed the
 * check. That is exactly the defect A29 describes, wearing a politeness.
 */

describe("an acknowledgement is not said twice", () => {
  it.each([
    ["Got it.", "ask_address"],
    ["Perfect, thanks.", "ask_address"],
    ["Great, thank you.", "success"],
    ["Thanks!", "ask_contact"],
    ["Understood.", "ask_availability"],
  ])("drops %j when the template already opens with one", (rapport, intent) => {
    const out = renderMessage({ intent: intent as never, freeText: rapport, turn: 0 });
    const plain = renderMessage({ intent: intent as never, turn: 0 });
    // Either the rapport was dropped entirely, or the template does not open
    // with an acknowledgement and keeping it is right.
    if (/^(?:got it|perfect|great|thanks|thank you|understood|good news)/i.test(plain)) {
      expect(out).toBe(plain);
    }
  });

  it("the case that started it", () => {
    const out = renderMessage({
      intent: "ask_address", freeText: "Got it.", addressGap: "zip", turn: 0,
      known: { address: "482 Marchmont Ave" },
    });
    expect(out).not.toMatch(/got it.*got it/i);
  });

  it("keeps rapport that goes on to say something", () => {
    const out = renderMessage({ intent: "ask_address", freeText: "Kitchen cabinets, got it.", turn: 0 });
    expect(out).toContain("Kitchen cabinets");
  });

  it("keeps an answer, which is never redundant", () => {
    const out = renderMessage({ intent: "ask_address", freeText: "Yes, we do those.", turn: 0 });
    expect(out).toContain("Yes, we do those.");
  });

  it("never produces the same opener twice in any combination", () => {
    // The sweep the reading did by eye, as an assertion.
    const openers = ["Got it.", "Perfect, thanks.", "Great, thank you.", "Thanks!", "Sorry about that."];
    const intents = ["ask_project_details", "ask_address", "ask_contact", "ask_availability",
      "acknowledge", "acknowledge_negative", "success", "present_offsite_quote"] as const;
    for (const intent of intents) {
      for (const rapport of openers) {
        for (const turn of [0, 1, 2]) {
          const out = renderMessage({ intent, freeText: rapport, turn });
          const first = out.split(/(?<=[.!?])\s/)[0]?.trim().toLowerCase();
          const second = out.split(/(?<=[.!?])\s/)[1]?.trim().toLowerCase();
          if (!first || !second) continue;
          expect({ intent, rapport, out, same: first === second }).toEqual({ intent, rapport, out, same: false });
        }
      }
    }
  });
});

describe("A29: a bare acknowledgement does not answer a question", () => {
  const asked = { customerText: "Do you do cabinets as well?", stage: 1 };

  it.each(["Got it.", "Perfect, thanks.", "Great!", "Understood.", "Sure.", "No problem."])(
    "refuses the turn when the only rapport is %j",
    (rapport) => {
      const v = validateAction({ intent: "ask_address", confidence: 0.9, freeText: rapport } as never, asked as never);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("question_left_unanswered");
    }
  );

  it.each(["Yes, we do those.", "Got it, cabinets are no problem.", "We do, including refinishing."])(
    "allows it when the rapport actually answers: %j",
    (rapport) => {
      expect(validateAction({ intent: "ask_address", confidence: 0.9, freeText: rapport } as never, asked as never).ok).toBe(true);
    }
  );
});

describe("what counts as bare", () => {
  it.each(["Got it.", "Perfect, thanks.", "Thanks!", "Sorry about that.", "Okay", "Sure, no problem."])(
    "%j is bare",
    (t) => { expect(BARE_ACKNOWLEDGEMENT.test(t.trim())).toBe(true); }
  );

  it.each([
    "Got it, cabinets are no problem.",
    "Yes, we do those.",
    "That sounds like a straightforward job.",
    "Happy to help with the exterior.",
  ])("%j is not", (t) => {
    expect(BARE_ACKNOWLEDGEMENT.test(t.trim())).toBe(false);
  });
});
