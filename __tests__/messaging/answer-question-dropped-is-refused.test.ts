import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { renderMessage, isSilent } from "@/lib/messaging/render";

/**
 * VALIDATED, THEN DELETED, THEN ESCALATED. 2026-10-16.
 *
 * answer_question has no template: its freeText is the whole message. A style
 * rule dropped that freeText and the validator still returned ok, so:
 *
 *   customer   "can you match the existing color?"
 *   model      answer_question + "Yes, we can color-match."
 *   validator  hyphenated compound, rapport dropped, ok: true
 *   renderer   ""
 *   agent-run  saysNothing, escalate — and the retry never ran, because it
 *              only runs on a refusal
 *
 * One rewording would have fixed it. The validator now refuses with the fix
 * in the detail, so the retry runs. Asserted as the PAIR: whatever the
 * validator accepts on answer_question, the renderer must send.
 */
const ctx = (customerText: string) => ({
  customerText,
  priorIntents: ["ask_project_details"],
  knownFields: {},
}) as never;

const asked = "can you match the existing color?";

describe("a dropped answer_question is refused, so the retry runs", () => {
  it.each([
    ["a hyphenated compound", "Yes, we can color-match."],
    ["an em dash", "Yes — we can match it."],
    ["a semicolon", "Yes; we match colors all the time."],
    ["parentheses", "Yes (we do that often)."],
  ])("refuses %s with the remedy, instead of passing an empty message", (_why, freeText) => {
    const v = validateAction({ intent: "answer_question", confidence: 0.97, freeText }, ctx(asked));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("answer_dropped_by_style");
    expect(v.detail).toMatch(/dropped because/);
    expect(v.detail).toMatch(/fix only that/i);
  });

  it("refuses an answer_question that carries no answer at all", () => {
    const v = validateAction({ intent: "answer_question", confidence: 0.97 }, ctx(asked));
    expect(v.ok === false && v.reason).toBe("answer_dropped_by_style");
  });

  /** THE CONTROL: the same answer, written cleanly, is allowed AND sent. */
  it.each([
    "Yes, we can match the color.",
    "Yes, we match existing colors all the time.",
  ])("allows and sends a clean answer: %j", (freeText) => {
    const v = validateAction({ intent: "answer_question", confidence: 0.97, freeText }, ctx(asked));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const out = renderMessage({ intent: "answer_question", turn: 1, freeText: v.action.freeText, customerText: asked });
    expect(out).toContain(freeText);
  });

  /** And nothing the validator accepts on answer_question renders to nothing. */
  it.each([
    "Yes, we can color-match.",
    "Yes, we can match the color.",
    "Most rooms take a day or two.",
    "Yes; we do.",
  ])("never accepts what the renderer then deletes: %j", (freeText) => {
    const v = validateAction({ intent: "answer_question", confidence: 0.97, freeText }, ctx(asked));
    if (!v.ok) return;
    const out = renderMessage({ intent: "answer_question", turn: 1, freeText: v.action.freeText, customerText: asked });
    expect(out, "validator accepted it, so it must be sent").not.toBe("");
  });

  /**
   * THE TEMPLATED INTENTS ARE UNCHANGED. A style drop there still costs only
   * the rapport, because the template carries the turn.
   */
  it("still only drops the rapport where a template carries the turn", () => {
    const v = validateAction(
      { intent: "ask_address", confidence: 0.97, freeText: "Sounds great, a full-room refresh." },
      { customerText: "the whole living room", priorIntents: ["ask_project_details"],
        knownFields: { inquiryScope: "living room" }, scopeFromCustomer: true } as never,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.droppedRapport).toMatch(/hyphenated/);
  });

  it("leaves msg_liked_loved alone: it is silent by design", () => {
    expect(isSilent({ intent: "msg_liked_loved" })).toBe(true);
    const v = validateAction({ intent: "msg_liked_loved", confidence: 0.97, freeText: "Thanks so much — glad!" },
      { customerText: "Loved “What’s the address?”" } as never);
    expect(v.ok === false && v.reason).not.toBe("answer_dropped_by_style");
  });
});
