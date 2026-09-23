import { describe, it, expect } from "vitest";
import { silenceOpenerProblem } from "@/lib/messaging/into-silence";
import { latestInboundIsAnswered } from "@/lib/messaging/handoff";

/**
 * A28: "A message sent into SILENCE must read as a close, not as a reply.
 * Never open with 'Got it' / 'Perfect' / 'Great' when no customer message
 * preceded it." 58 breaches.
 *
 * The interesting half of this rule is where it CANNOT happen. The agent is
 * refused a turn whenever the most recent message is outbound, so every turn
 * the model takes answers something a customer just said. Campaign steps are
 * the exception, because they fire on a schedule, and their bodies were the
 * one piece of customer-facing text with no check on them.
 */

describe("the agent structurally cannot send into silence", () => {
  const at = (n: number) => new Date(2026, 8, 23, 10, n).toISOString();

  it("refuses a turn when the last message is ours", () => {
    // scheduler-db skips the turn when this returns true. That is what makes
    // A28 unreachable from the model's side.
    expect(latestInboundIsAnswered([
      { direction: "inbound", created_at: at(0) },
      { direction: "outbound", created_at: at(1) },
    ])).toBe(true);
  });

  it("allows a turn when the customer spoke last", () => {
    expect(latestInboundIsAnswered([
      { direction: "outbound", created_at: at(0) },
      { direction: "inbound", created_at: at(1) },
    ])).toBe(false);
  });

  it("does not depend on array order", () => {
    // It compares timestamps rather than trusting the order rows came back
    // in, which is the difference between a guarantee and a coincidence.
    expect(latestInboundIsAnswered([
      { direction: "outbound", created_at: at(5) },
      { direction: "inbound", created_at: at(1) },
    ])).toBe(true);
  });
});

describe("a campaign follow-up may not open like a reply", () => {
  it.each([
    "Got it, thank you. When would you like us to come out?",
    "Perfect, thanks. What days work best?",
    "Great! Are you still looking to get this done?",
    "Understood. Let us know if you still want an estimate.",
    "I hear you. Happy to get someone out.",
    "Thanks for confirming. When suits you?",
    "You're all set. Anything else?",
    "No problem, just checking in.",
    "Absolutely, we can help with that.",
  ])("refuses %j", (body) => {
    const p = silenceOpenerProblem(body);
    expect(p).not.toBeNull();
    expect(p).toContain("they never sent");
  });

  it("names the words it objected to, so the fix is obvious", () => {
    expect(silenceOpenerProblem("Got it, thank you.")).toContain('"Got it"');
  });
});

describe("what a follow-up is allowed to say", () => {
  it.each([
    // The two bodies actually configured today.
    "Hi, just following up on your estimate request. Are you still looking to get this done? Happy to get someone out to take a look.",
    "Checking in one more time about your painting project. Let us know if you would still like an estimate and we will get it scheduled.",
    // Other shapes that read as a follow-up rather than an answer.
    "Hi there, wanted to see whether you are still thinking about the painting.",
    "We have not heard back, so we will leave it here for now.",
    "Hello from Precision Painting Plus. Still happy to get you a quote whenever suits.",
  ])("allows %j", (body) => {
    expect(silenceOpenerProblem(body)).toBeNull();
  });

  it("only looks at the START of the message", () => {
    // "Got it" mid-sentence is not what the rule describes, and matching it
    // anywhere would refuse bodies that are perfectly fine.
    expect(silenceOpenerProblem("Just following up. Once we have got it booked we will confirm.")).toBeNull();
  });

  it("leaves an empty body to whatever else checks that", () => {
    expect(silenceOpenerProblem("")).toBeNull();
    expect(silenceOpenerProblem(null)).toBeNull();
  });
});
