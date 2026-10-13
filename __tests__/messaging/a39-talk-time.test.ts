import { describe, it, expect } from "vitest";
import { availabilityGap, availabilityGapAcross, withoutTalkTimes } from "@/lib/messaging/availability";

/**
 * A39, live and critical: "Neither a project TIMELINE nor a time the customer
 * can TALK is appointment AVAILABILITY. Either way they still owe availability
 * for the appointment itself."
 *
 * availability.ts had never heard of it. Found 2026-10-13 by listing the live
 * rules mentioned nowhere in the codebase and running the parser against what
 * each one actually says.
 */
describe("A39 — a time they can TALK is not a time they can meet", () => {
  it.each([
    "you can call me at 3pm",
    "I can talk Tuesday afternoon",
    "best time to reach me is mornings",
    "text me after 5",
    "give me a ring Thursday morning",
    "feel free to contact me Monday afternoon",
  ])("still owes availability after %j", (t) => {
    expect(availabilityGap(t)).toBe("both");
  });

  it.each([
    "me puede llamar el martes por la tarde",
    "hábleme el jueves en la mañana",
  ])("in Spanish too: %j", (t) => {
    expect(availabilityGap(t)).toBe("both");
  });

  /** Timelines were already safe. Pinned so they stay that way. */
  it.each([
    "I'd like it done by June",
    "we want it finished before the holidays",
    "looking to start sometime next month",
  ])("a project timeline is not availability either: %j", (t) => {
    expect(availabilityGap(t)).toBe("both");
  });

  /** The line this must not cross: real availability still parses. */
  it.each([
    ["Tuesday afternoon works for the estimate", null],
    ["I'm free Thursday morning", null],
    ["Thursday works", "window"],
    ["afternoons are best", "day"],
    ["el jueves por la mañana", null],
    ["anytime works", null],
  ] as const)("real availability is untouched: %j", (t, want) => {
    expect(availabilityGap(t)).toBe(want);
  });

  /**
   * Both in one message. The talk clause goes, the appointment clause stays —
   * which is why this is a clause test and not a message test.
   */
  it("keeps the real half of a mixed message", () => {
    expect(availabilityGap("call me Monday, and Tuesday afternoon works for the estimate")).toBe(null);
    expect(withoutTalkTimes("call me Monday, and Tuesday afternoon works for the estimate"))
      .toMatch(/Tuesday afternoon/);
  });

  it("does not strip a clause that names the visit", () => {
    // "call ... to confirm the estimate" is about the appointment, not a phone slot.
    expect(withoutTalkTimes("call me Tuesday to confirm the estimate")).toMatch(/Tuesday/);
  });

  it("treats an open offer to TALK as no availability", () => {
    expect(availabilityGap("call me whenever")).toBe("both");
    expect(availabilityGap("anytime works")).toBe(null);
  });

  /**
   * WHY THIS MATTERED. A13 forbids asking again for something already given,
   * so a talk-time banked as availability could never be corrected: the bot
   * would stop asking and the close guard would believe it held a slot.
   * Across a thread is where that belief is formed.
   */
  it("does not let a talk-time complete availability across a thread", () => {
    expect(availabilityGapAcross(["I can talk Tuesday afternoon"])).toBe("both");
    expect(availabilityGapAcross([
      "I can talk Tuesday afternoon",
      "Thursday morning works for the estimate",
    ])).toBe(null);
  });
});
