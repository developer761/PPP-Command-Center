import { describe, it, expect } from "vitest";
import { availabilityGapAcross, availabilityGap, retractsAvailability } from "@/lib/messaging/availability";

/**
 * ONCE GIVEN, NEVER ASKABLE AGAIN.
 *
 * availabilityGapAcross accumulates over the whole thread and nothing cleared
 * it, so a single message carrying a day and a window made the gap null for
 * the rest of the conversation — permanently. "Something came up, Tuesday
 * won't work" then left the bot unable to ask what day would:
 * ask_availability is refused as availability_already_given, and the refusal
 * detail tells the model to move the conversation on rather than ask again.
 *
 * The rule it trips over is right. Asking twice for something already given is
 * A13, which is what the accumulation protects. "Do not ask twice" was never
 * meant to mean "never ask again after they change their mind" — the
 * correct-rules-with-no-legal-move-between-them shape, costing the booking.
 */
describe("a customer who changes their mind can be asked again", () => {
  const gave = "Tuesday afternoon works for me";

  it("is complete once a day and a window are given", () => {
    expect(availabilityGapAcross([gave])).toBeNull();
  });

  it.each([
    "Something came up, Tuesday won't work",
    "Actually Tuesday no longer works",
    "I need to reschedule Tuesday",
    "Tuesday isn't going to work, sorry",
    "Changed my mind about Tuesday afternoon",
    "Surgió algo, el martes ya no puedo",
    "El martes ya no me sirve",
    "Tengo que cambiar el martes",
  ])("reopens the gap after: %j", (retraction) => {
    expect(availabilityGapAcross([gave, retraction]),
      `still closed after a retraction: ${retraction}`).not.toBeNull();
  });

  it("asks what DAY works, not just the window", () => {
    // The retracted message contains "Tuesday", so reading it would leave the
    // bot narrowing a window against a day they have just withdrawn.
    expect(availabilityGapAcross([gave, "Something came up, Tuesday won't work"])).toBe("both");
  });

  it("closes again once they give a new day and window", () => {
    expect(availabilityGapAcross([
      gave,
      "Something came up, Tuesday won't work",
      "Thursday morning instead",
    ])).toBeNull();
  });

  /**
   * AND AN OBJECTION TO SOMETHING ELSE MUST NOT REOPEN IT.
   *
   * Several of these phrases are ordinary objections — "no me sirve" is as
   * likely to be about the price as the day. The retraction is bound to a day
   * or a window appearing in the same message for exactly this reason: a
   * customer who objected to a quote must not then be asked for their
   * availability all over again.
   */
  it.each([
    "That price won't work for me",
    "No me sirve ese precio",
    "The quote doesn't work, too expensive",
    "I changed my mind about the colors",
    "Cancel that, I meant the other room",
  ])("does not reopen on an objection with no day in it: %j", (text) => {
    expect(availabilityGapAcross([gave, text]),
      `an unrelated objection reopened availability: ${text}`).toBeNull();
  });

  it("is not triggered by giving availability normally", () => {
    for (const t of ["Tuesday afternoon works", "Thursday morning is good", "el martes por la tarde"]) {
      expect(retractsAvailability(t), t).toBe(false);
    }
  });

  /**
   * The bare-assent carve-out still belongs to the last message only, and a
   * retraction must not change that. "Yes please" after a retraction is a yes
   * to whatever was last asked, which is no longer an availability question.
   */
  it("leaves the single-message reading alone", () => {
    expect(availabilityGap("Tuesday afternoon works")).toBeNull();
    expect(availabilityGap("Tuesday won't work")).toBe("window");
  });
});

/**
 * THE VALIDATOR AND THE RENDERER DISAGREED ABOUT ONE MESSAGE.
 *
 * agent-run builds the availability gap TWICE, on purpose, and the comment
 * there explains why: the validator asks "is there bookable availability
 * anywhere in this conversation" (availabilityGapAcross) while the renderer
 * words the follow-up about what the customer just wrote (availabilityGap on
 * ownWords).
 *
 * That reasoning is right and it had a hole. The per-message copy reads any
 * day it finds as a day SUPPLIED, and a retraction names the day it is
 * withdrawing. Seen live in the Spanish sandbox, 2026-10-08:
 *
 *   customer  "Surgio algo, el martes ya no puedo"
 *   bot       "No hay problema. Qué horario le funciona esos días?"
 *
 * The validator had it right — the gap reopened, which is why ask_availability
 * was allowed at all — and the renderer narrowed to the WINDOW, asking what
 * time works on the day just cancelled.
 *
 * Asserted on the two functions together, because what was wrong was that
 * they disagreed, not either one alone.
 */
describe("the per-message gap does not read a day out of a retraction", () => {
  it.each([
    ["Surgio algo, el martes ya no puedo", "es"],
    ["Something came up, Tuesday won't work", "en"],
    ["El martes ya no me sirve", "es"],
    ["Actually Tuesday no longer works for us", "en"],
  ])("treats %j as nothing supplied", (text) => {
    // What the renderer now uses: a retraction means the DAY is missing, so
    // the unnarrowed ask is the right question.
    expect(retractsAvailability(text)).toBe(true);
    // And what it used to use, which is where the wrong wording came from.
    expect(availabilityGap(text), "the bare parser still reads a day here, which is the trap")
      .not.toBeNull();
  });

  /**
   * AND THE TWO AGREE AFTERWARDS. The validator reopening while the renderer
   * narrows is the failure; both treating it as nothing supplied is the fix.
   */
  it("agrees with the across-thread view after a retraction", () => {
    const thread = ["Tuesday afternoon works for me", "Something came up, Tuesday won't work"];
    expect(availabilityGapAcross(thread)).toBe("both");
    expect(retractsAvailability(thread[1])).toBe(true);
  });

  /** An ordinary partial answer still narrows, which is the whole point of
   *  keeping the renderer's copy per-message. */
  it("still narrows an ordinary day-only answer to the window", () => {
    expect(retractsAvailability("Tuesday works for me")).toBe(false);
    expect(availabilityGap("Tuesday works for me")).toBe("window");
  });
});
