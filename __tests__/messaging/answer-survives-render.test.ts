import { describe, it, expect } from "vitest";
import { renderMessage, rapportIsRedundant } from "@/lib/messaging/render";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * THE VALIDATOR KEPT THE ANSWER AND THE RENDERER THREW IT AWAY.
 *
 * Found live 2026-10-05, and it is the worst shape in this codebase because
 * nothing reports it. The customer asked "what times do you have available
 * this week?"; the model answered in freeText and asked for the address.
 *
 *   validateAction  ALLOWED the turn — `saysSomething` is one of the things
 *                   that satisfies the A29 guard, so the answer being present
 *                   is the ONLY reason this turn was legal
 *   renderMessage   dropped that answer as redundant, because it shared words
 *                   with the template, and sent:
 *
 *       "What address should we have the estimator go to?"
 *
 * The customer's direct question ignored, while the validator believed it had
 * been answered and the suite stayed green.
 *
 * agent-output already documents this exact collision for yes/no questions —
 * "the echo rule removes the answer, and then this guard sees no answer and
 * escalates... two correct rules with no legal move between them" — and fixed
 * it there with affirmsAYesNo. This is the same collision for every other kind
 * of question, and it is worse: it does not escalate, it ships.
 */
describe("an answer is never dropped as redundant", () => {
  const asked = "what times do you have available this week?";
  const answers = [
    "The estimator sets those times.",
    "The estimator sets the times, and the office will confirm what's open.",
    "Our estimator handles the scheduling.",
  ];

  it.each(answers)("keeps %j in front of the address ask", (freeText) => {
    const out = renderMessage({
      intent: "ask_address", turn: 2, freeText, customerText: asked,
      known: { scope: "living room", address: null },
    } as never);
    expect(out).toContain(freeText);
    expect(out).toMatch(/address/i);
  });

  /**
   * THE TWO HALVES HAVE TO AGREE. If the validator accepts a turn because the
   * answer is there, the renderer must send that answer — otherwise the rule
   * passes and the customer is still ignored. This asserts the pair, which is
   * the only way this bug was ever going to be caught.
   */
  it.each(answers)("renders whatever the validator accepted: %j", (freeText) => {
    const res = validateAction(
      { intent: "ask_address", confidence: 0.97, freeText },
      {
        customerText: asked,
        priorIntents: ["ask_project_details", "ask_address"],
        knownFields: { inquiryScope: "living room", address: null },
        scopeFromCustomer: true,
      } as never
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = renderMessage({
      intent: "ask_address", turn: 2, freeText: res.action.freeText, customerText: asked,
      known: { scope: "living room", address: null },
    } as never);
    expect(out, "the validator kept this answer, so the renderer must send it")
      .toContain((res.action.freeText ?? "").trim());
  });

  /**
   * AND THE REDUNDANCY RULE KEEPS ITS JOB when nothing is owed. "Got it,
   * thank you." in front of a template that opens the same way is still two
   * acknowledgements stacked, which is the tell of a machine.
   */
  /**
   * THE GATE IS A GATE, not a way of switching the rule off. Same rapport and
   * same template as the first case — a pair rapportIsRedundant calls
   * redundant — but the customer stated something instead of asking, so
   * nothing is owed and the repeat is still dropped.
   */
  it("still drops the repeat when no question was asked", () => {
    const out = renderMessage({
      intent: "ask_address", turn: 2, freeText: "The estimator sets those times.",
      customerText: "ok sounds good",
      known: { scope: "living room", address: null },
    } as never);
    expect(out).not.toContain("The estimator sets those times.");
    expect(out).toMatch(/address/i);
  });

  it("leaves the redundancy test itself alone", () => {
    // The helper is unchanged — only whether the renderer acts on it.
    expect(rapportIsRedundant("The estimator sets those times.",
      "What address should we have the estimator go to?")).toBe(true);
  });

  /** answer_question already carries the whole message; nothing may drop it. */
  it("never drops the answer on answer_question", () => {
    const out = renderMessage({
      intent: "answer_question", turn: 1,
      freeText: "Yes, we do prep work as part of every job.",
      customerText: "do you do the prep work too?", known: {},
    } as never);
    expect(out).toContain("prep work");
  });
});
