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

/**
 * AND IT HAS TO SURVIVE THE EARLY RETURNS, which is where it was still dying.
 *
 * The guard above sits at the bottom of renderBody, in the branch that
 * assembles the message from parts. A dozen branches return a template
 * directly before ever reaching it — the week-aware availability ask, the
 * requested-time reply, the returning-customer reply, the callback window, the
 * discard lines — and every one of them dropped `freeText` on the floor.
 *
 * Same collision, same silence: validateAction allows the turn BECAUSE the
 * answer is there, and the customer receives only the question.
 */
describe("the answer survives the branches that return early", () => {
  const asked = "ok. how long will the whole job take?";
  const answer = "Most rooms take a day or two.";

  /** Wednesday 2pm ET, so the week-aware ask has a week to name. */
  const now = new Date("2026-07-15T18:00:00Z");

  it("the week-aware availability ask keeps it", () => {
    const out = renderMessage({
      intent: "ask_availability", freeText: answer, customerText: asked,
      now, customerZone: "America/New_York", flowStage: 3, turn: 0,
    });
    expect(out).toContain("day or two");
    // And still asks the question it was rendering.
    expect(out).toMatch(/\?/);
  });

  it("the callback-window reply keeps it", () => {
    const out = renderMessage({
      intent: "schedule_follow_up", freeText: answer,
      customerText: "could you call me instead? and how long will the whole job take?",
      turn: 0,
    });
    expect(out).toContain("day or two");
  });

  it("does not prepend when the intent's own template answers them", () => {
    // defer_to_estimator is in ANSWERS_A_QUESTION: the template IS the answer,
    // and prepending rapport saying the same thing is the duplication the
    // redundancy rule exists to remove.
    const out = renderMessage({
      intent: "defer_to_estimator", freeText: "The estimator works that out.",
      customerText: asked, flowStage: 0, track: "new_lead", turn: 0,
    });
    expect(out).not.toContain("The estimator works that out. The estimator");
  });

  it("does not prepend when the customer asked nothing", () => {
    const out = renderMessage({
      intent: "ask_availability", freeText: "Got it, thank you.",
      customerText: "12 Hilton Ave, Garden City 11530",
      now, customerZone: "America/New_York", flowStage: 3, turn: 0,
    });
    expect(out).not.toContain("Got it, thank you. Got it");
  });
});
