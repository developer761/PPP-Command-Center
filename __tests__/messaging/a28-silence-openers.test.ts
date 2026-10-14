import { describe, it, expect } from "vitest";
import { silenceOpenerProblem } from "@/lib/messaging/into-silence";

/**
 * A28 — "A message sent into SILENCE must read as a close, not as a reply."
 *
 * The check was wired correctly (campaign-write refuses the step at save
 * time) and the PATTERN was too narrow: it caught the three openers Kate
 * quotes and allowed nine more that read exactly the same way.
 */
describe("A28 — openers that answer a message nobody sent", () => {
  it.each([
    "Got it, thanks for confirming.",
    "Perfect! We'll get that moving.",
    "Great, thanks.",
  ])("still refuses the originals: %j", (t) => {
    expect(silenceOpenerProblem(t)).not.toBeNull();
  });

  it.each([
    ["Thanks for getting back to me! Let us know when works.", "they did not get back to us"],
    ["Thanks so much! We'll hold your spot.", "for what?"],
    ["Thank you! We'll be in touch.", "for what?"],
    ["Glad to hear it.", "hear what?"],
    ["No worries at all, take your time.", "answering an apology never made"],
    ["Got your message, we'll get that moving.", "there was no message"],
    ["Sounds like a plan.", "nobody proposed one"],
    ["I appreciate you letting me know.", "they did not let us know"],
    ["Will do!", "agreeing to a request never made"],
    ["As discussed, the estimator will be in touch.", "nothing was discussed"],
  ])("now refuses %j — %s", (t) => {
    expect(silenceOpenerProblem(t)).not.toBeNull();
  });

  /**
   * THE LINE IT MUST NOT CROSS. A campaign step is written by a person, and
   * a false positive stops them saving a perfectly good follow-up.
   *
   * "Thanks for your patience" credits something PASSIVE that is genuinely
   * true of somebody left waiting three days — unlike "thanks for getting
   * back to me", which credits an action they never took.
   */
  it.each([
    "Just following up on your estimate request.",
    "Checking in on the estimate for your kitchen.",
    "Wanted to circle back about the quote.",
    "Hi! We still have your project on file. Want us to take a look?",
    "We have not heard back, so we will close this out unless you need anything.",
    "Hope the project is going well. Let us know if you still need an estimate.",
    "Thanks for your patience, the estimator has a slot this week.",
    "Thanks for waiting on this. Are you still after a quote?",
    "Hi John, following up on the living room estimate.",
  ])("allows the real follow-up %j", (t) => {
    expect(silenceOpenerProblem(t)).toBeNull();
  });

  /**
   * Several alternatives end in punctuation, so the terminator is (?!\w) and
   * not \b: "Thanks so much!" consumes the "!" and \b then demands a
   * boundary between "!" and a space — two non-word characters, no boundary,
   * no match. That bug allowed the opener through on the first attempt.
   */
  it("matches an opener that ends in punctuation", () => {
    expect(silenceOpenerProblem("Thanks so much! We'll hold your spot.")).not.toBeNull();
    expect(silenceOpenerProblem("Thank you! We'll be in touch.")).not.toBeNull();
  });

  it("names the offending words so the editor can see what to change", () => {
    expect(silenceOpenerProblem("Glad to hear it.")).toContain("Glad to hear");
  });
});
