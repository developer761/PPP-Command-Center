import { describe, it, expect } from "vitest";
import { validateAction, namesHour } from "@/lib/messaging/agent-output";

/**
 * Question 15, open since 2026-09-28 "for Karan", settled 2026-10-16 from
 * the two rule texts — which turn out not to conflict at all.
 *
 *   A15  "Do NOT offer, confirm or suggest specific APPOINTMENT times"
 *   A25  "captured a callback time inside business hours, CONFIRMED IT BACK
 *         TO THE CUSTOMER, and handed the conversation to a human"
 *
 * An appointment is the estimator coming to the property; a callback is
 * somebody ringing them. A25 REQUIRES confirming the second back, and
 * invented_availability refused any time at all — so the bot could not
 * comply with A25's own happy path:
 *
 *   customer  "can you call me instead of texting? 2pm is good"
 *   model     "Of course, 2pm works."    -> invented_availability, turn lost
 *
 * Two correct rules with no legal move between them.
 */
const ctx = (customerText: string) => ({
  customerText, knownFields: { inquiryScope: true }, addressGap: null,
  templateAsks: () => false, customerMessages: [], flowStage: 2,
}) as never;

const V = (rapport: string, customerText: string, intent = "answer_question") =>
  validateAction({ intent, confidence: 0.97, freeText: rapport }, ctx(customerText));

const CALLBACK = "can you call me instead of texting? 2pm is good";

describe("A25 — confirming the callback hour the customer named", () => {
  it.each([
    "Of course, 2pm works.",
    "Sure, 2pm it is.",
    "No problem, 2pm.",
  ])("allows %j, which is their own hour coming back", (rapport) => {
    expect(V(rapport, CALLBACK).ok).toBe(true);
  });

  /** Nothing is invented: the hour has to be the one THEY named. */
  it.each([
    "Of course, 4pm works.",
    "How about 10am?",
    "We have openings at 3pm.",
  ])("still refuses %j", (rapport) => {
    const v = V(rapport, CALLBACK);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("invented_availability");
  });

  /**
   * AN APPOINTMENT IS NOT A CALLBACK. "can you come Tuesday at 2?" asks for
   * a visit, which A15 governs and the bot has no calendar for — the
   * carve-out must not reach it.
   */
  it.each(["Of course, 2pm works.", "2pm is open."])(
    "still refuses %j on a visit request", (rapport) => {
      expect(V(rapport, "can you come Tuesday at 2?").ok).toBe(false);
    });

  it("still refuses a time when none was requested at all", () => {
    expect(V("Of course, 2pm works.", "I need my living room painted").ok).toBe(false);
  });
});

describe("namesHour recognises the hour however it is written", () => {
  it.each(["2pm works", "at 2 PM", "2 o'clock", "14:00"])("finds 14 in %j", (t) => {
    expect(namesHour(t, 14)).toBe(true);
  });
  it.each(["4pm works", "noon", "no time here"])("does not find 14 in %j", (t) => {
    expect(namesHour(t, 14)).toBe(false);
  });
});
