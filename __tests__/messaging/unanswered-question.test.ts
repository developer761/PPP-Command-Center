import { describe, it, expect } from "vitest";
import { validateAction, asksSomething, checkTone } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A29 and A33 are a pair, and Kate draws the line between them herself:
 *
 *   "BOUNDARY WITH A33: A33 is a question the bot CANNOT answer — defer it to
 *    the estimator and keep going. A29 is one it CAN answer and did not."
 *
 * A29, 31 breaches, critical. The correction on 28 of them is one sentence:
 * "answered the direct question, at whatever point in the conversation it was
 * asked."
 *
 * A33, 30 breaches, critical. The correction on all 30: "deferred the question
 * to the estimator without ending the conversation."
 */

const ask = (intent: string, ctx: Record<string, unknown> = {}, freeText?: string) =>
  validateAction({ intent, confidence: 0.9, ...(freeText ? { freeText } : {}) } as never, ctx as never);

describe("spotting a direct question", () => {
  it.each([
    "Can I speak to someone on the phone?",
    "You accept credit cards right?",
    "Is the meeting before the actual painting?",
    "how much per room",
    "what time works",
    "do you do cabinets",
    "when can someone come out",
  ])("sees the question in %j", (t) => {
    expect(asksSomething(t)).toBe(true);
  });

  it.each([
    "Just purchased a home and looking for a quote to do interior paint",
    "2000 sq ft interior painting",
    "Hi. This is for a 2 bedroom apartment.",
    "Text is fine! Thanks so much",
    "",
  ])("does not see one in %j", (t) => {
    expect(asksSomething(t)).toBe(false);
  });
});

describe("A29: a direct question is never left unanswered", () => {
  const asked = { customerText: "Do you do kitchen cabinets?", stage: 1 };

  it("refuses a turn that only asks the next question back", () => {
    const v = ask("ask_address", asked);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("question_left_unanswered");
      expect(v.detail).toContain("only asks the next question back");
    }
  });

  it("allows it when the turn carries an answer", () => {
    // Kate's model answer is "Absolutely. What time works best for you?" —
    // the answer is the rapport, the next step is the template.
    const v = ask("ask_address", asked, "Yes, we do those.");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.action.freeText).toBe("Yes, we do those.");
  });

  it("allows an intent that answers by its nature", () => {
    for (const intent of ["answer_question", "defer_to_estimator", "escalate", "confirm_address"]) {
      expect(ask(intent, { ...asked, knownFields: { address: true } }).ok, intent).toBe(true);
    }
  });

  it("says so when the answer was written and then dropped", () => {
    // A dropped answer leaves the question just as unanswered as never
    // writing one, and the reason a person needs is WHY it was dropped.
    const v = ask("ask_address", asked, "Yes, since your place is small we can do that");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toContain("dropped because");
  });

  it("stays out of the way when nothing was asked", () => {
    expect(ask("ask_address", { customerText: "It is a 2 bedroom apartment", stage: 1 }).ok).toBe(true);
  });

  it("stays out of the way when the caller tracks no customer text", () => {
    expect(ask("ask_address", { stage: 1 }).ok).toBe(true);
  });

  it("applies at ANY point, not only before closing", () => {
    // The rule's own emphasis. A question at stage 3 binds like one at stage 0.
    expect(ask("ask_availability", { ...asked, stage: 3 }).ok).toBe(false);
    expect(ask("ask_project_details", { ...asked, stage: 0 }).ok).toBe(false);
  });
});

describe("A33: defer, and keep the conversation going", () => {
  it("has words of its own, separate from escalate", () => {
    const deferred = renderMessage({ intent: "defer_to_estimator", turn: 0 });
    const escalated = renderMessage({ intent: "escalate", turn: 0 });
    expect(deferred).not.toBe(escalated);
    expect(deferred.length).toBeGreaterThan(0);
  });

  it("names who will answer, and does not end the conversation", () => {
    for (let turn = 0; turn < 4; turn++) {
      const out = renderMessage({ intent: "defer_to_estimator", turn });
      expect(out, out).toMatch(/estimator|office/i);
      // "Deflecting is correct; ENDING the conversation in order to deflect
      // is not." Every variant ends on a question, so it cannot read as a
      // sign-off.
      expect(out.trim().endsWith("?"), out).toBe(true);
    }
  });

  it("does not sound like the closes it replaces", () => {
    for (let turn = 0; turn < 4; turn++) {
      const out = renderMessage({ intent: "defer_to_estimator", turn });
      expect(out).not.toMatch(/here if you need us|leave it there|reach out any time|get back to you/i);
    }
  });

  it("asks one thing, not two", () => {
    for (let turn = 0; turn < 4; turn++) {
      const out = renderMessage({ intent: "defer_to_estimator", turn });
      expect((out.match(/\?/g) ?? []).length, out).toBe(1);
    }
  });

  it("can be chosen at any stage, because a question comes when it comes", () => {
    for (const stage of [0, 1, 2, 3, 4]) {
      expect(ask("defer_to_estimator", { stage, customerText: "what time are you free?" }).ok, `stage ${stage}`).toBe(true);
    }
  });
});

/**
 * PROVE IT CAN FAIL.
 *
 * The A29 check only fires when the caller supplies customerText, which most
 * of the suite does not. Without these the whole file would pass against code
 * that never runs.
 */
describe("the check is genuinely reachable", () => {
  it("the same action passes and fails purely on the question", () => {
    const withQuestion = ask("ask_address", { customerText: "do you do cabinets?", stage: 1 });
    const withStatement = ask("ask_address", { customerText: "we have cabinets", stage: 1 });
    expect(withQuestion.ok).toBe(false);
    expect(withStatement.ok).toBe(true);
  });

  it("and purely on whether an answer is carried", () => {
    const ctx = { customerText: "do you do cabinets?", stage: 1 };
    expect(ask("ask_address", ctx).ok).toBe(false);
    expect(ask("ask_address", ctx, "We do.").ok).toBe(true);
  });
});

/**
 * ── "YES" IS A WHOLE ANSWER TO A YES/NO QUESTION ────────────────────────
 *
 * Seen live on 2026-09-28. "Can someone come out and look at my living room?"
 * — one of the commonest openings a painting lead has — was handed to a
 * person on turn one, every time, and no wording could rescue it:
 *
 *   "Absolutely." / "Of course."   read as a bare acknowledgement, because
 *                                  both words are in BARE_ACKNOWLEDGEMENT
 *   "Yes, an estimator can come
 *    out and look at it."          dropped by the echo rule — "it repeats
 *                                  the customer's own words back"
 *
 * Answering a yes/no question naturally reuses the verb it was asked with, so
 * the echo rule removes the answer; then this guard sees no answer and
 * escalates. Two correct rules with no legal move between them.
 *
 * And the guard's own comment cites Kate's model answer — "Absolutely. What
 * time works best for you?" — which is precisely the sentence it refused.
 */
describe("a yes/no question is answered by yes", () => {
  const turn = (customerText: string, freeText?: string) =>
    validateAction(
      { intent: "ask_address", confidence: 0.9, ...(freeText ? { freeText } : {}) } as never,
      { customerText, knownFields: { inquiryScope: true }, stage: 1 } as never
    );

  const CAN_YOU = "Can someone come out and look at my living room?";
  const HOW_MUCH = "How much will it cost to paint my living room?";
  const CABINETS = "Do you do cabinets as well?";

  it.each(["Absolutely.", "Of course.", "Yes.", "Sure thing.", "For sure."])(
    "accepts %j as the answer to a yes/no question", (rapport) => {
      expect(turn(CAN_YOU, rapport).ok).toBe(true);
    }
  );

  it.each([undefined, "Got it.", "Okay.", "Thanks!", "No worries."])(
    "still refuses %j, which acknowledges rather than answers", (rapport) => {
      const v = turn(CAN_YOU, rapport);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toBe("question_left_unanswered");
    }
  );

  /**
   * THE CARVE-OUT MUST NOT LEAK TO OPEN QUESTIONS. "How much will it cost?"
   * met with "Absolutely" is the politeness-shaped non-answer A29 exists to
   * catch, and it stays caught.
   */
  it.each(["Absolutely.", "Of course.", "Sure thing.", "For sure.", "Got it."])(
    "refuses %j as the answer to an open question", (rapport) => {
      expect(turn(HOW_MUCH, rapport).ok).toBe(false);
    }
  );

  it("still accepts a real answer to an open question", () => {
    expect(turn(HOW_MUCH, "Pricing comes from the estimator after they see it.").ok).toBe(true);
  });

  it("does not treat a wh-question as yes/no just for containing a modal", () => {
    // "What days can you come?" opens with a wh-word. An affirmative alone
    // does not answer it.
    expect(turn("What days can you come out?", "Absolutely.").ok).toBe(false);
  });
});

/**
 * AND THE LINE THIS CARVE-OUT MUST NOT CROSS.
 *
 * "Do you do cabinets as well?" is a yes/no question too, and "Sure." is NOT
 * an acceptable answer: whether we do cabinets depends on the workspace's
 * service list, so an affirmative there is a capability claim that can be
 * false. Whether somebody can come out is not a claim of that kind — it is
 * what the flow exists to arrange and it is true in every workspace.
 *
 * rapport-stacking.test.ts holds that line from the other side; this states
 * it here too, because the two are one decision and a future edit to either
 * regex should have to break both.
 */
describe("affirming a VISIT is not affirming a CAPABILITY", () => {
  const turn = (customerText: string, freeText: string) =>
    validateAction(
      { intent: "ask_address", confidence: 0.9, freeText } as never,
      { customerText, knownFields: { inquiryScope: true }, stage: 1 } as never
    );

  it.each([
    "Can someone come out and look at my living room?",
    "Could you stop by next week?",
    "Can you send someone to take a look?",
    "Would somebody come see the job first?",
  ])("accepts a plain yes to %j", (q) => {
    expect(turn(q, "Absolutely.").ok).toBe(true);
  });

  it.each([
    "Do you do cabinets as well?",
    "Do you handle exterior work?",
    "Can you paint kitchen cabinets?",
  ])("still demands a real answer to %j", (q) => {
    const v = turn(q, "Sure.");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("question_left_unanswered");
  });
});

/**
 * THE ECHO RULE MUST LET THE ANSWER THROUGH TOO.
 *
 * Fixing the A29 guard alone changed nothing live, because the answer never
 * reached it: the model wrote one, and checkTone dropped it for repeating the
 * customer's own words. "Yes, an estimator can come out and look at it"
 * shares five words with "Can someone come out and look at my living room?" —
 * because those five words ARE the question.
 *
 * That is the same three-guard pileup the `refusingWorkWeDoNotDo` carve-out
 * documents one case over: "each guard was written for a bot trying to SELL;
 * none of them expected it to say no." None expected it to say yes either.
 */
describe("answering a visit question may reuse the words it was asked with", () => {
  const VISIT = "Can someone come out and look at my living room?";
  const SCOPE = "I need my living room and hallway painted, walls and ceilings";

  it.each([
    "Yes, an estimator can come out and look at it.",
    "Absolutely, someone can come out and look at it.",
    "Yes, we can come out and take a look.",
  ])("keeps %j", (t) => {
    expect(checkTone(t, VISIT).ok).toBe(true);
  });

  it("still blocks reading the customer's SCOPE back at them", () => {
    // A9's actual target: the fake confirmation that quotes their description.
    expect(checkTone("Got it, your living room and hallway painted, walls and ceilings.", SCOPE).ok)
      .toBe(false);
  });

  it("still blocks an echo that does not open with an affirmative", () => {
    // Both halves are required. Reusing the verb is only defensible as part
    // of saying yes.
    expect(checkTone("Someone can come out and look at it, no problem.", VISIT).ok).toBe(false);
  });

  it("carries the answer all the way through validate, not just checkTone", () => {
    // The end-to-end shape: the answer survives the style filter AND satisfies
    // A29, so the turn sends instead of handing to a person.
    const v = validateAction(
      { intent: "ask_address", confidence: 0.9, freeText: "Yes, an estimator can come out and look at it." } as never,
      { customerText: VISIT, knownFields: { inquiryScope: true }, stage: 1 } as never
    );
    expect(v.ok).toBe(true);
    expect(v.ok === true && v.droppedRapport).toBeUndefined();
  });
});
