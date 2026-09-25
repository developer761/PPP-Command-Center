import { describe, it, expect } from "vitest";
import { checkRapport } from "@/lib/messaging/agent-output";

/**
 * A32: "CUT THE REASON — the ask stands alone, with no justification
 * attached. No 'since you're moving', no 'before we schedule anything', no
 * 'so we can get you taken care of'. A reason padded onto a routine ask makes
 * the message longer without making it clearer." 199 breaches.
 *
 * Checked on the model's RAPPORT and nowhere else, and that is the whole
 * design. Our templates and campaign bodies were checked and carry no reason
 * clauses, so rapport is the only channel through which one can appear. The
 * rule's exceptions are all template text — A7's off-site offer explains a
 * real departure and its reason is MANDATED — so they cannot reach this
 * check at all, which is why it needs no exception logic.
 */

/** Every string here was sent by the bot in Kate's graded corpus. */
describe("the reasons Kate actually marked", () => {
  it.each([
    "Just checking back so we can get your free quote moving",
    "Hi there, just circling back so we can get this on the estimator's schedule",
    "Hi again, just checking in so I can keep your cabinet quote moving along",
    "Since it's already Thursday, we have a few openings next week to meet with you",
    "Got it. Since it's a small shed, we can provide a quick quote for this project",
    "Since this is a smaller, rush project, we can quote it remotely",
    "we can text or email you a quote for faster turnaround",
    "he'll be able to provide you a quote over the phone to save you a visit",
    "Perfect, just circling back so we can get this locked in for you",
  ])("drops %j", (text) => {
    const r = checkRapport(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("pads the ask with a reason");
  });
});

/**
 * FIRST PERSON ONLY.
 *
 * "so we can" explains our process and is the padding Kate describes. "so you
 * can" is the customer's benefit. Run over the 2,861 non-question bot
 * sentences in the corpus, the broader pattern flagged 18 and the only two
 * that were arguable were both second person — and one of them is Kate's own
 * redirect carve-out, where proposing a visit after the customer asked for
 * something else IS a departure that owes an explanation.
 */
describe("a reason for the customer's benefit is not padding", () => {
  it.each([
    "Totally understand, we'll give you a heads up before anyone arrives so you can get the dog settled",
    "Totally understand, and we can keep everything clear by going over it in person so you can ask questions",
  ])("keeps %j", (text) => {
    expect(checkRapport(text).ok).toBe(true);
  });
});

describe("ordinary rapport still goes out", () => {
  it.each([
    "Got it, thank you.",
    "Perfect, thanks.",
    "Happy to help with that.",
    "That sounds like a straightforward job.",
    "So glad to hear it.",
    "No problem at all.",
    "Sounds good.",
    "Great, thanks for confirming.",
    "Understood.",
  ])("keeps %j", (text) => {
    expect(checkRapport(text).ok).toBe(true);
  });

  it("does not fire on a bare 'so'", () => {
    // "so that works", "so glad" — rapport, which is what the field is for.
    expect(checkRapport("So that works nicely.").ok).toBe(true);
    expect(checkRapport("So glad we could sort it.").ok).toBe(true);
  });
});

/**
 * PROVE IT CAN FAIL. Every assertion above passes on an empty string, and a
 * pattern that silently stopped matching would leave this suite green.
 */
describe("the check is doing something", () => {
  it("names the clause it objected to", () => {
    const r = checkRapport("Just checking in so we can get you scheduled");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("so we can get you scheduled");
  });

  it("rejects a reason but accepts the same sentence without one", () => {
    expect(checkRapport("Just checking in so we can get you scheduled").ok).toBe(false);
    expect(checkRapport("Just checking in.").ok).toBe(true);
  });
});
