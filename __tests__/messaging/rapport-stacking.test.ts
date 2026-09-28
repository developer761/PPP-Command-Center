import { describe, it, expect } from "vitest";
import { renderMessage, rapportIsRedundant } from "@/lib/messaging/render";
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

/**
 * THE MIRROR CASE: A BARE TEMPLATE AFTER SUBSTANTIVE RAPPORT.
 *
 * Played in the simulator on 2026-09-27. The customer parked:
 *
 *   customer  "I want the upstairs hallway and 2 bedrooms done, but let me
 *              check with my wife and get back to you"
 *   BOT       "No rush at all, take your time with that. Got it, thank you."
 *
 * A40 was honoured — it did not press for another field, which is the rule
 * that matters. But the rapport carried the whole message and the template
 * repeated it as an afterthought. The same shape appeared on the off-site
 * turn: "Text works. Sure thing. What are you hoping to have painted?"
 *
 * rapportIsRedundant caught a bare "Got it" in FRONT of an acknowledging
 * template and could not catch the reverse.
 */
describe("a template that only acknowledges, after rapport that already did", () => {
  const park = "let me check with my wife and get back to you";

  it("keeps the rapport and drops the bare template", () => {
    const out = renderMessage({
      intent: "acknowledge", turn: 1,
      freeText: "No rush at all, take your time with that.", customerText: park,
    });
    expect(out).toBe("No rush at all, take your time with that.");
    expect(out).not.toMatch(/got it|thanks/i);
  });

  it("never goes silent — with no rapport the template still speaks", () => {
    const out = renderMessage({ intent: "acknowledge", turn: 1, freeText: "", customerText: park });
    expect(out.length).toBeGreaterThan(0);
  });

  it("still drops a BARE rapport in front of an acknowledging template", () => {
    const out = renderMessage({ intent: "acknowledge", turn: 1, freeText: "Got it.", customerText: park });
    expect(out.startsWith("Got it. ")).toBe(false);
  });

  /**
   * The template wins everywhere it does real work. Only a bare
   * acknowledgement loses, because it neither asks the next question nor says
   * anything the rapport has not.
   */
  it("never drops a template that asks something", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 1,
      freeText: "That sounds like a great project.", customerText: "paint my kitchen",
    });
    expect(out).toMatch(/That sounds like a great project\./);
    expect(out).toMatch(/\?$/);
  });
});

/**
 * TWO ACKNOWLEDGEMENT OPENERS, NEITHER OF THEM BARE.
 *
 * The nurture customer who accepted a quote, in the simulator on 2026-09-27:
 *
 *   customer  "no need for a call, lets just go ahead with it, when can you
 *              start"
 *   BOT       "That's great news, thanks for the go ahead. That's great to
 *              hear! I'll let the office know so they can get you booked in."
 *
 * The same sentiment twice in consecutive sentences. Neither half is a BARE
 * acknowledgement, so the first guard missed it; "That's great" is two words
 * and the echo threshold is four, so the second missed it too. And the opener
 * pattern could not see past "That's" to the word that makes it one.
 */
describe("the same enthusiasm twice", () => {
  it("keeps one acknowledgement, not two", () => {
    const out = renderMessage({
      intent: "accepted", turn: 1, track: "nurture",
      freeText: "That's great news, thanks for the go ahead.",
      customerText: "lets just go ahead with it",
    });
    expect(out).not.toMatch(/that's great news/i);
    expect((out.match(/great|wonderful|excellent|fantastic/gi) ?? []).length).toBeLessThanOrEqual(1);
  });

  it("still says what happens next", () => {
    const out = renderMessage({
      intent: "accepted", turn: 1, track: "nurture",
      freeText: "That's great news, thanks for the go ahead.",
      customerText: "lets just go ahead with it",
    });
    expect(out).toMatch(/office|schedule|booked/i);
  });

  it("does not promise a start date", () => {
    // They asked "when can you start". The office owns the calendar.
    const out = renderMessage({
      intent: "accepted", turn: 1, track: "nurture",
      freeText: "That's great news.", customerText: "when can you start",
    });
    expect(out).not.toMatch(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    expect(out).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
  });

  it("leaves rapport that actually says something", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 1,
      freeText: "I can see this is a big job.", customerText: "paint my house",
    });
    expect(out).toMatch(/I can see this is a big job\./);
  });
});

/**
 * THE SAME ANSWER IN DIFFERENT WORDS — the fourth stacking shape.
 *
 * Replaying a real thread Hatch had ABANDONED (Marisol Vega, NY LI Nassau:
 * she asked for a ballpark and Hatch never replied), our bot answered — and
 * answered twice:
 *
 *   customer  "And what's the ballpark on something like that?"
 *   BOT       "Pricing comes from our estimator once they've looked over the
 *              details. That's one for the estimator, and they'll go through
 *              it with you. What days suit you best?"
 *
 * A1 satisfied, no price, the question answered — and the same fact stated
 * twice. Neither half is a bare acknowledgement, and the longest shared run is
 * "the estimator": two words against a threshold of four.
 *
 * Our templates are built around very few nouns — estimator, office, calendar,
 * pricing, quote. Rapport naming the SAME one is answering a question the
 * template already answers.
 */
describe("rapport that answers what the template already answers", () => {
  it("drops the duplicate, keeping the template", () => {
    const out = renderMessage({
      intent: "defer_to_estimator", turn: 1,
      freeText: "Pricing comes from our estimator once they've looked over the details.",
      customerText: "And what's the ballpark on something like that?",
    });
    expect(out).not.toMatch(/pricing comes from/i);
    expect(out).toMatch(/estimator/i);
    expect((out.match(/estimator/gi) ?? []).length).toBe(1);
  });

  it("still quotes no price", () => {
    const out = renderMessage({
      intent: "defer_to_estimator", turn: 1,
      freeText: "Pricing comes from our estimator once they've looked over the details.",
      customerText: "And what's the ballpark on something like that?",
    });
    expect(out).not.toMatch(/\$|\b\d+\s*(?:dollars|usd)\b/i);
  });

  /**
   * NARROW ON PURPOSE. It needs the SAME noun in both halves — two different
   * subjects are two different things and both survive.
   */
  it("keeps rapport about a different subject", () => {
    expect(rapportIsRedundant("I'll let the office know.", "I'll check the calendar for that time.")).toBe(false);
    expect(rapportIsRedundant("That sounds like a big job.", "What's the address for the project?")).toBe(false);
  });
});
