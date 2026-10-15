import { describe, it, expect } from "vitest";
import { checkRapport } from "@/lib/messaging/agent-output";

/**
 * A15 — "Do NOT offer, confirm or suggest specific appointment times."
 *
 * The bot has no calendar; the office owns it. The existing
 * invented_availability check catches a NAMED day or hour, and these name
 * none — they point AT the time the customer named and agree to it, which
 * lands in the same place as A35: somebody waiting in for an appointment
 * nobody booked.
 *
 * DEFENCE IN DEPTH: 0 of 2,155 faulted and 0 of 651 praised messages in
 * Kate's corpus trip it. The wording has not occurred; the cost if it did is
 * a customer sitting at home for a visit that was never scheduled.
 */
const R = (t: string) => checkRapport(t, undefined, false, false);

describe("A15 — the bot cannot agree to a time it has no calendar for", () => {
  it.each([
    "Yes, that time works for us.",
    "That works, we'll see you then.",
    "Sure, the time you mentioned is open.",
    "I'll confirm you for the time you asked about.",
    "Our estimator is free at that hour, so it's confirmed.",
    "You're all set for the slot you asked about.",
  ])("refuses %j", (t) => {
    expect(R(t).ok).toBe(false);
  });

  /**
   * THE LINE IT MUST NOT CROSS. The time pointer alone is everywhere in
   * approved copy — the first is our own template and the third Kate
   * praised. Both halves have to land in ONE clause, and a clause that asks
   * is exempt.
   */
  it.each([
    "I'll check the calendar for that time.",
    "I'll check the calendar for that time. What time window works best for you?",
    "What time window works for you that day?",
    "Looking forward to connecting then. Have a great day.",
    "The estimator will confirm that with you directly.",
    "Our office confirms the timing, so they'll lock that in with you.",
    "What time window should I put you down for the estimator to stop by?",
    "Happy to help with that.",
  ])("allows %j", (t) => {
    expect(R(t).ok).toBe(true);
  });

  /**
   * "confirm" and "confirmed" are different words, and the first version had
   * only the second — so "I'll confirm you for the time you asked about"
   * went through. Pinned because the near-miss "the estimator will confirm
   * that with you" must keep passing, which is what makes the verb alone
   * unsafe to match on.
   */
  it("catches the verb as well as the participle, without catching the deferral", () => {
    expect(R("I'll confirm you for the time you asked about.").ok).toBe(false);
    expect(R("The estimator will confirm that with you directly.").ok).toBe(true);
  });
});
