import { describe, it, expect } from "vitest";
import {
  shouldEscalate, validateAction, ANSWERS_A_QUESTION, LOW_STAKES_FLOOR,
} from "@/lib/messaging/agent-output";

/**
 * "How much would it cost?" — the commonest thing a painting lead opens with.
 *
 * Two separate failures met on this one question, both found by playing it in
 * the sandbox against production on 2026-10-06 rather than by any test:
 *
 *   1. The model answered inside an ask — ask_address plus "Our estimator
 *      handles pricing, so I can't give a number myself." A32 deleted the
 *      reason as padding, and the turn was then refused as
 *      question_left_unanswered. The refusal described the WORDING, so the
 *      retry reworded it, hit the identical wall, and the conversation went to
 *      a person. Twice out of twice.
 *
 *   2. With the right intent chosen it still handed over, because
 *      defer_to_estimator sat on the strict 0.95 threshold while the model
 *      reports about 0.85 on this question.
 *
 * Neither is visible from a unit test of either piece alone, which is why both
 * are pinned here together: the question has to be ANSWERABLE and the answer
 * has to be SENDABLE, and a fix to one that breaks the other is no fix.
 */

const act = (intent: string, confidence: number, freeText = "") =>
  ({ intent, freeText, confidence, reasoning: "" }) as Parameters<typeof shouldEscalate>[0];

describe("a price question can be answered at all", () => {
  it("defer_to_estimator is an intent that ANSWERS, so it satisfies A29", () => {
    expect(ANSWERS_A_QUESTION.has("defer_to_estimator")).toBe(true);
  });

  it("an ask does not answer it, however the reason is worded", () => {
    // The shape that looped: the answer bolted onto the next question.
    for (const wording of [
      "Our estimator handles pricing, so I can't give a number myself.",
      "Our estimator handles pricing, so I can't give a number here.",
    ]) {
      const v = validateAction(
        { intent: "ask_address", freeText: wording, confidence: 0.9 },
        { customerText: "How much to paint a 12x14 bedroom? Just give me a ballpark" }
      );
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.reason).toBe("question_left_unanswered");
        // AND THE REFUSAL HAS TO POINT SOMEWHERE. One retry is all the model
        // gets; spending it on a synonym is how this reached a person twice.
        expect(v.detail).toMatch(/rewording will not fix it/i);
        expect(v.detail).toContain("defer_to_estimator");
      }
    }
  });
});

describe("a price question does not hand the conversation to a person", () => {
  it("does not escalate at the confidence the model actually reports", () => {
    // 0.85 observed twice in the sandbox, against the live 0.95 threshold.
    expect(shouldEscalate(act("defer_to_estimator", 0.85), { confidenceThreshold: 0.95 })).toBe(false);
  });

  it("still escalates when the model is genuinely lost", () => {
    // LOW_STAKES_FLOOR, not "never escalate".
    expect(shouldEscalate(act("defer_to_estimator", LOW_STAKES_FLOOR - 0.1), { confidenceThreshold: 0.95 })).toBe(true);
  });

  it("leaves the intents that commit PPP to something on the strict threshold", () => {
    // The distinction the file draws is consequence, not correctness. If this
    // ever goes green for these, the exception has been widened too far.
    for (const intent of ["answer_question", "offer_offsite_quote", "present_offsite_quote", "success"]) {
      expect(shouldEscalate(act(intent, 0.85), { confidenceThreshold: 0.95 }), intent).toBe(true);
    }
  });
});
