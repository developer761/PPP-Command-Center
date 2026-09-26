/**
 * Hatch parity gaps 2-4: what to say when the customer names a time.
 *
 * The negatives matter most. A number in a text message is usually not a
 * time — it is a house number, a room count, a square footage — and reading
 * one as a time puts a wrong appointment in front of a person.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBareHour, requestedTime, slotVerdict, replyToRequestedTime,
  FIRST_SLOT_HOUR, LAST_SLOT_HOUR,
} from "@/lib/messaging/appointment-time";

describe("a bare hour, per Hatch's rule", () => {
  // "Assume times between 8 and 11 are AM and 12 to 7 are PM."
  it("8 through 11 are morning", () => {
    expect(resolveBareHour(8)).toBe(8);
    expect(resolveBareHour(11)).toBe(11);
  });

  it("12 is noon and 1 through 7 are afternoon", () => {
    expect(resolveBareHour(12)).toBe(12);
    expect(resolveBareHour(1)).toBe(13);
    expect(resolveBareHour(3)).toBe(15);
    expect(resolveBareHour(7)).toBe(19);
  });

  it("refuses anything that is not a clock hour", () => {
    for (const h of [0, 13, 25, -1, 1.5, NaN]) expect(resolveBareHour(h)).toBeNull();
  });
});

describe("reading a time out of a message", () => {
  const cases: Array<[string, { hour: number; minute: number; explicit: boolean } | null]> = [
    ["can you do 2pm", { hour: 14, minute: 0, explicit: true }],
    ["2:30 pm works", { hour: 14, minute: 30, explicit: true }],
    ["how about 9am", { hour: 9, minute: 0, explicit: true }],
    ["12pm please", { hour: 12, minute: 0, explicit: true }],
    ["12am is fine", { hour: 0, minute: 0, explicit: true }],
    ["at 10:15", { hour: 10, minute: 15, explicit: false }],
    // THE ONE THE RULE EXISTS FOR — a bare 3 means the afternoon.
    ["at 3", { hour: 15, minute: 0, explicit: false }],
    ["around 9", { hour: 9, minute: 0, explicit: false }],
    // Qualified by words rather than by am/pm.
    ["at 8 in the morning", { hour: 8, minute: 0, explicit: true }],
    ["at 4 in the afternoon", { hour: 16, minute: 0, explicit: true }],
  ];
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)}`, () => {
      expect(requestedTime(text)).toEqual(want);
    });
  }
});

describe("numbers that are NOT times", () => {
  /**
   * Each of these is a real thing a customer says. Reading one as a time puts
   * a wrong appointment in front of a person, which is worse than missing a
   * real one — the customer will say it again.
   */
  for (const t of [
    "4821 Oak Lane",
    "I have 3 rooms to paint",
    "about 2 bedrooms and a bath",
    "roughly 1500 sq ft",
    "my zip is 11722",
    "2 cars in the driveway",
    "I need 4 windows done",
    "whenever suits you",
    "",
  ]) {
    it(`${JSON.stringify(t)} names no time`, () => {
      expect(requestedTime(t)).toBeNull();
    });
  }

  it("a bare number with no preposition is not a time", () => {
    // "3 works" could be three rooms. A time needs at/around/by, a colon,
    // or an am/pm.
    expect(requestedTime("3 works for me")).toBeNull();
  });
});

describe("which side of the appointment day it falls on", () => {
  it("inside is inside", () => {
    expect(slotVerdict({ hour: 10, minute: 0, explicit: true })).toBe("in_hours");
    expect(slotVerdict({ hour: 14, minute: 30, explicit: true })).toBe("in_hours");
    expect(slotVerdict({ hour: LAST_SLOT_HOUR, minute: 0, explicit: true })).toBe("in_hours");
  });

  it("before the first slot", () => {
    expect(slotVerdict({ hour: 8, minute: 0, explicit: true })).toBe("too_early");
    expect(slotVerdict({ hour: FIRST_SLOT_HOUR - 1, minute: 59, explicit: true })).toBe("too_early");
  });

  it("after the last slot, including five past five", () => {
    expect(slotVerdict({ hour: LAST_SLOT_HOUR, minute: 5, explicit: true })).toBe("too_late");
    expect(slotVerdict({ hour: 19, minute: 0, explicit: true })).toBe("too_late");
  });
});

describe("what the bot says back", () => {
  /**
   * THE POINT OF ALL THREE GAPS. Hatch says it twice — "Do not restate or
   * confirm their time", "Don't thank them" — because a reply that repeats
   * the time reads as agreement, and A15 forbids agreeing to a slot nobody
   * checked.
   */
  it("holds an in-hours time without confirming it", () => {
    const r = replyToRequestedTime("can you do Tuesday at 2?")!;
    expect(r.verdict).toBe("in_hours");
    expect(r.reply).toBe("I'll check the calendar for that time.");
  });

  it("never restates the time, on any branch", () => {
    for (const t of ["can you do 2pm", "how about 7am", "how about 8pm", "at 3"]) {
      const r = replyToRequestedTime(t);
      expect(r, t).not.toBeNull();
      // No digits at all in the in-hours line; the out-of-hours lines name
      // OUR slot, never theirs.
      expect(r!.reply, t).not.toMatch(/\b(?:2|7|8|3)\s*(?:pm|am|o'clock)\b/i);
      expect(r!.reply, t).not.toMatch(/tuesday/i);
    }
  });

  it("redirects a too-early time without refusing it", () => {
    const r = replyToRequestedTime("can someone come at 7am?")!;
    expect(r.verdict).toBe("too_early");
    expect(r.reply).toContain("10 AM");
    expect(r.reply).toMatch(/Saturday/);
    // Leaves a door open rather than saying no.
    expect(r.reply).toMatch(/\?$/);
  });

  it("redirects a too-late time", () => {
    const r = replyToRequestedTime("8pm is the only time I can do")!;
    expect(r.verdict).toBe("too_late");
    expect(r.reply).toContain("5 PM");
  });

  it("says nothing when no time was named", () => {
    expect(replyToRequestedTime("I need my kitchen painted")).toBeNull();
    expect(replyToRequestedTime("4821 Oak Lane")).toBeNull();
  });

  it("offers no specific slot of its own — that would be A15", () => {
    /**
     * The first version of this test asserted the reply contains no weekday
     * at all, and failed on "or a Saturday" — which is Hatch's own approved
     * wording and is NOT an offer. "I can ask about a Saturday" names a
     * category of day we would check; "Saturday at 2 works" invents an
     * appointment. Only the second is A15, so this asserts the thing A15
     * actually forbids rather than the thing that was easy to match.
     */
    for (const t of ["7am?", "9pm?"]) {
      const r = replyToRequestedTime(t)!;
      // No day paired with a time, which is what an offered slot looks like.
      expect(r.reply, t).not.toMatch(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.?!]{0,12}\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?\b/i);
      expect(r.reply, t).not.toMatch(/\btomorrow\b|\bnext week\b/i);
      // And no offering language. We ask; we never propose.
      expect(r.reply, t).not.toMatch(/\bhow about\b|\bwe have (?:an? )?opening|\bI have\b|\bdoes .* work\b/i);
    }
  });

  it("and the A15 detector above actually detects an offer", () => {
    // Otherwise the assertions pass over a check that never fires.
    const offered = "Saturday at 2 works, I have an opening then.";
    expect(offered).toMatch(/\b(?:satur)day\b[^.?!]{0,12}\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?\b/i);
    expect(offered).toMatch(/\bI have\b/i);
  });
});
