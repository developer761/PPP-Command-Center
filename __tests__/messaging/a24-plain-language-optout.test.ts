import { describe, it, expect } from "vitest";
import { classifyInbound } from "@/lib/messaging/compliance";

/**
 * A24 — "Honor opt-outs."
 *
 * Nine of ten plain-language opt-outs classified as "normal", so the bot
 * would have REPLIED to somebody who asked it to stop. That is not a quality
 * problem, it is the one failure in this system nobody is allowed to have.
 *
 * Measured over 4,966 real customer messages from Kate's corpus: the
 * widening newly suppresses THREE, and all three are genuine opt-outs —
 * "remove from list", "Don't keep texting me please", and one whose
 * operative clause is "please stop with the constant texting and calling".
 * Nothing else changed.
 */
describe("A24 — opt-outs said in plain language", () => {
  it.each([
    "please halt all communication",
    "please cease all communication",
    "I want to end all communication with you",
    "stop communication",
    "take my number off your list",
    "remove my number from your list",
    "don't keep texting me",
    "opt out",
    "remove from list",
    "stop with the constant texting",
  ])("now honours %j", (t) => {
    expect(classifyInbound(t)).toBe("opt_out");
  });

  it.each([
    "STOP", "stop texting me", "take me off your list",
    "stop all communication", "please stop contacting me",
    "unsubscribe", "leave me alone", "no more texts",
  ])("still honours %j", (t) => {
    expect(classifyInbound(t)).toBe("opt_out");
  });

  /**
   * AN OPT-OUT IS NOT A DECLINE, and getting it backwards suppresses a live
   * lead for good. These decline the SERVICE and belong to A17.
   */
  it.each([
    "No thanks, we hired someone else",
    "we're all set for now",
    "I'm not interested",
    "we decided to go another direction",
  ])("does not suppress the decline %j", (t) => {
    expect(classifyInbound(t)).toBe("normal");
  });

  /**
   * The verb after "stop" stays ENUMERATED. These are the sentences the
   * original pattern was shaped around and they must never match.
   */
  it.each([
    "Can you stop by tomorrow?",
    "stop by the house at 2",
    "I'll stop by your office",
  ])("never reads %j as an opt-out", (t) => {
    expect(classifyInbound(t)).toBe("normal");
  });

  /** A stated channel preference is A25, not an opt-out. */
  it.each([
    "please call me instead",
    "can you text me the quote",
    "my communication preference is email",
  ])("leaves the channel preference %j alone", (t) => {
    expect(classifyInbound(t)).toBe("normal");
  });

  /** The real message that drove the "with the constant" branch. */
  it("honours an opt-out buried after a park", () => {
    expect(classifyInbound(
      "I already mentioned that I am in no way shape or form ready for this. "
      + "I will reach out when I’m ready, please stop with the constant texting and calling",
    )).toBe("opt_out");
  });
});
