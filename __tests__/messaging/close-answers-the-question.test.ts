import { describe, it, expect } from "vitest";
import { validateAction, ANSWERS_A_QUESTION, CLOSES } from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * QUESTION 35 — A29 SAYS "AT ANY POINT, NOT ONLY BEFORE CLOSING", AND THE
 * CLOSE WAS THE ONE PLACE IT WAS NOT ENFORCED.
 *
 *   customer  "do you do ceilings as well?"
 *   bot       "Perfect, you're all set. Someone from the office will confirm
 *              the details with you."
 *
 * Allowed, because `success` sat in ANSWERS_A_QUESTION — the set of intents
 * whose own template answers by its nature. Nothing in that set's comment
 * covered it, and nothing could: "you're all set" says nothing about
 * ceilings. Every other ending — lost, bailout — was already refused in that
 * state.
 *
 * The write-up left the call to Kate for fear of stranding a finished
 * booking. It does not: the close keeps its intent and carries the answer in
 * front of it, which is what the deadlock test at the bottom pins. One
 * retry, not a handover.
 */
const held = {
  scope: "living room walls",
  address: "14 Beech St Hicksville NY 11801",
  phone: "+19995551212",
  email: "a@b.com",
  name: "Dana",
};
/**
 * `accepted` NEEDS A YES, since 2026-10-16 (accepted_without_agreement): a
 * nurture customer who only asks "do you do ceilings as well?" has not
 * accepted anything. So on that close the customer says yes AND asks, which
 * is the case this file is about — the best-case customer who agrees and
 * asks one last thing.
 */
const close = (intent: string, track: "new_lead" | "nurture", customerText: string, freeText = "") => ({
  action: { intent, freeText, confidence: 0.9 },
  ctx: {
    known: held, flowStage: 4, track,
    customerText: intent === "accepted" ? `Yes, let's go ahead. ${customerText}` : customerText,
  },
});

describe("a close does not swallow the customer's question", () => {
  it.each([
    ["success", "new_lead"],
    ["accepted", "nurture"],
  ] as const)("%s is refused when a question is pending and nothing answers it", (intent, track) => {
    const { action, ctx } = close(intent, track, "do you do ceilings as well?");
    const v = validateAction(action, ctx);
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ reason: "question_left_unanswered" });
  });

  /**
   * AND THE REMEDY HAS TO BE THE RIGHT ONE, because the model gets one retry
   * and a refusal pointing at the wrong intent spends it.
   *
   * The standing remedy says "an answer cannot ride along on an ask — choose
   * defer_to_estimator instead". True of a turn that asks, and ruinous here:
   * the booking is done, and swapping the intent would reopen it.
   */
  it("tells the close to keep its intent, not to swap it", () => {
    const { action, ctx } = close("success", "new_lead", "do you do ceilings as well?");
    const v = validateAction(action, ctx);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.detail).toMatch(/keep this intent/i);
    expect(v.detail).not.toMatch(/defer_to_estimator/);
  });

  it.each([
    ["success", "new_lead"],
    ["accepted", "nurture"],
  ] as const)("%s passes once it carries the answer", (intent, track) => {
    const { action, ctx } = close(intent, track, "do you do ceilings as well?", "Yes, we do ceilings.");
    expect(validateAction(action, ctx).ok).toBe(true);
  });

  /**
   * AND A CLOSE WITH NOTHING PENDING IS UNTOUCHED. The commonest close of all
   * follows "sounds good" — no question, nothing owed, no new refusal.
   */
  it.each([
    ["success", "new_lead", "sounds good thanks"],
    ["accepted", "nurture", "lets go ahead"],
  ] as const)("%s still closes plainly when nothing was asked", (intent, track, customerText) => {
    const { action, ctx } = close(intent, track, customerText);
    expect(validateAction(action, ctx).ok).toBe(true);
  });

  it("the pair is named as a pair", () => {
    for (const intent of CLOSES) expect(ANSWERS_A_QUESTION.has(intent)).toBe(false);
    expect([...CLOSES].sort()).toEqual(["accepted", "success"]);
  });

  /**
   * THE DEADLOCK TEST, which is the reason this is safe to decide without
   * her. A29 now demands an answer on the close; A32's padding rule, the echo
   * rule, A8's scope guard and the renderer's own filters all still apply. If
   * no sentence satisfied all of them the close would be unreachable and the
   * best-case customer — the one who says yes and asks one last thing — would
   * be the one handed to a person, which is this codebase's signature bug.
   *
   * So: for each question, at least one plain answer must both pass the
   * validator AND survive to the customer. Checked end to end rather than at
   * the validator alone, because an answer the renderer deletes is not an
   * answer and the validator cannot see that.
   */
  const answers = [
    ["do you do ceilings as well?", "Yes, we do ceilings."],
    ["will you move the furniture?", "Yes, the crew handles that."],
    ["how long will it take?", "The estimator will give you a timeline when they come out."],
    ["is the paint low voc?", "Low VOC options are available."],
    ["do i need to be home?", "Someone should be there to let the crew in."],
  ] as const;
  // Both closes, because the twin is the one that goes unchecked. Each close
  // is recognised by its own template's words.
  const closes = [
    ["success", "new_lead", /all set/i],
    ["accepted", "nurture", /booked in/i],
  ] as const;
  it.each(closes.flatMap(([intent, track, marker]) =>
    answers.map(([customerText, freeText]) => [intent, track, marker, customerText, freeText] as const),
  ))("%s: there is a legal answer to %s that reaches the customer", (intent, track, marker, customerText, freeText) => {
    const { action, ctx } = close(intent, track, customerText, freeText);
    expect(validateAction(action, ctx).ok).toBe(true);
    const out = renderMessage({
      intent,
      freeText,
      customerText,
      track,
      language: "en" as const,
      turn: 0,
      flowStage: 4,
      known: held,
    });
    expect(out).toContain(freeText);
    // And the close itself is still there — the answer is added, not substituted.
    expect(out).toMatch(marker);
  });
});
