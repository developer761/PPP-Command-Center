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

/**
 * THE REASON PUT IN FRONT OF THE ASK, WHICH IS HALF HER A32 FINDINGS.
 *
 * Every breach line below is a bot message from Kate's own corpus that she
 * graded as an A32 breach and the clause list missed. The patterns she already
 * had caught 88 of her 198; nearly all 110 misses were this one family — the
 * same padding, the same rule, the reason simply ahead of the ask rather than
 * behind it. With the prefaces added it is 160 of 198, and the number of
 * messages she praised FOR A32 that get flagged stays at zero.
 */
describe("a purpose preface is a reason (from Kate's corpus)", () => {
  it.each([
    "Got it, Dana. To get you on the schedule, what day and time window usually works best for you to meet the estimator at the property?",
    "Got it. Before I get this set up, can you please send your first and last name, plus the best phone number and email to reach you for the quote?",
    "Got it. To get this moving, what's the full property address in Hollywood, including the zip code?",
    "Got it. Before we get you set up, can you share your first and last name, best phone number, and email for the quote details?",
    "Yes, you can send pictures here. Before I get this set up for the estimator, could you confirm the full address for the project, including the zip?",
  ])("flags the padding in: %j", (text) => {
    const r = checkRapport(text, undefined, false);
    expect(r.ok, "a reason was bolted onto the ask and went out").toBe(false);
  });

  /**
   * SECOND PERSON SURVIVES, which is the carve-out the original patterns were
   * written around: "so you can" and "before you" describe the CUSTOMER's
   * benefit and read as a courtesy, not as our process explained at them.
   * Kate marked both of these acceptable.
   */
  it.each([
    "We'll give you a heads up before anyone arrives so you can get the dog settled.",
    "We can keep everything clear by going over it in person so you can ask questions.",
    /**
     * CONSTRUCTED, not from the corpus, and it is here because the comment on
     * REASON_CLAUSE claims second person is left alone and nothing tested
     * that claim for "before". Widening the pattern to "before (we|i|you)"
     * passed every other test in this file, so the claim was decorative.
     */
    "Before you decide anything, the estimator will walk you through the options.",
  ])("leaves the customer's own benefit alone: %j", (text) => {
    expect(checkRapport(text, undefined, false).ok, "a courtesy to the customer was dropped as padding").toBe(true);
  });
});
