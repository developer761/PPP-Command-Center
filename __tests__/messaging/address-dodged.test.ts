import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A QUESTION BACK IS NOT A REFUSAL, SO THE ADDRESS IS STILL OWED.
 *
 * Played live 2026-10-05, twice — the second time against a build whose prompt
 * had just been told not to do it:
 *
 *   bot       "What's the address for the project?"
 *   customer  "what times do you have available this week?"
 *   bot       answered honestly, then asked for NAME AND EMAIL
 *
 * and never asked for the address again. Four turns later the close was
 * refused for the address we never got and the lead went to a person.
 *
 * Answering was right — A29 binds at any point. ADVANCING was not. A41 says do
 * not block the flow on a REFUSAL, and a question is not a refusal.
 *
 * The prompt line came first and the model declined it, which is why this is a
 * refusal: "a prompt instruction the model can decline is the exact shape this
 * file exists to replace".
 */
const ctx = (over: Record<string, unknown> = {}) => ({
  customerText: "what times do you have available this week?",
  priorIntents: ["ask_project_details", "ask_address"],
  knownFields: { inquiryScope: "living room", address: null },
  scopeFromCustomer: true,
  ...over,
}) as never;

const act = (intent: string, freeText = "") => ({ intent, confidence: 0.97, freeText });

describe("a dodged address stops the flow advancing", () => {
  it.each(["ask_contact", "ask_availability", "success", "phone_pricing"])(
    "refuses %s", (intent) => {
      const res = validateAction(act(intent), ctx());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("address_question_walked_past");
    }
  );

  /**
   * confirm_contact is in the same set but never reaches this guard: with no
   * contact on file it is already refused as unknown_intent, because there is
   * nothing to read back. Asserted as refused rather than as refused BY this
   * rule — pinning the wrong reason here would break the day somebody fixes
   * the order of two guards that already agree.
   */
  it("refuses confirm_contact, by whichever guard gets there first", () => {
    expect(validateAction(act("confirm_contact"), ctx()).ok).toBe(false);
  });

  it("still allows asking for the address again", () => {
    const res = validateAction(
      act("ask_address", "The estimator sets the times and they'll confirm them with you."),
      ctx()
    );
    expect(res.ok).toBe(true);
  });

  /**
   * THE EXITS, which are what stop this being a trap. A customer who turns
   * abusive, opts out or just wants an answer must never be held here.
   */
  it.each(["answer_question", "escalate", "bailout", "discard", "lost", "defer_to_estimator"])(
    "leaves %s available", (intent) => {
      const res = validateAction(act(intent, "The estimator sets those times."), ctx());
      expect(res.ok, intent).toBe(true);
    }
  );
});

describe("and it lets go rather than nagging", () => {
  /**
   * Two asks is what Kate already accepted for the zip floor; a third would be
   * the nagging A41 forbids. The free text answers the question so the
   * separate A29 guard is satisfied and this one is what is being measured.
   */
  it("allows advancing once the address has been asked for twice", () => {
    const res = validateAction(
      act("ask_contact", "The estimator sets the times and will confirm them with you."),
      ctx({ priorIntents: ["ask_project_details", "ask_address", "ask_address"] })
    );
    expect(res.ok).toBe(true);
  });

  /** A REFUSAL is not a question, so the refusal ladder is untouched. */
  it.each([
    "id rather not give my address out over text",
    "no im not giving that out, i told you",
    "I'd prefer not to share that",
  ])("does not fire on a refusal: %j", (customerText) => {
    const res = validateAction(act("ask_contact"), ctx({ customerText }));
    expect(res.ok).toBe(true);
  });

  /** And an address actually given ends it, obviously. */
  it("does not fire once we hold an address", () => {
    const res = validateAction(
      act("ask_contact", "The estimator sets those times."),
      ctx({ knownFields: { inquiryScope: "living room", address: "12 Oak St, 11530" } })
    );
    expect(res.ok).toBe(true);
  });

  /** A statement that is not a question and not a refusal also passes through. */
  it("does not fire on an ordinary non-answer", () => {
    const res = validateAction(
      act("ask_contact"),
      ctx({ customerText: "ok sounds good" })
    );
    expect(res.ok).toBe(true);
  });
});
