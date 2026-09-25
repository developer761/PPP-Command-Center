import { describe, it, expect } from "vitest";
import { validateAction, asksSomething } from "@/lib/messaging/agent-output";
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
