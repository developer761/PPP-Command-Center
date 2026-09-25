import { describe, it, expect } from "vitest";
import { statedConstraint, blocked, reachableHour } from "@/lib/messaging/reachability";

/**
 * A44: "A STATED CONSTRAINT MOVES THE CADENCE... A cadence that fires into a
 * window the customer already ruled out is a defect EVEN IF THE CUSTOMER NEVER
 * COMPLAINS."
 *
 * The parser is timid on purpose. Missing a constraint costs one badly timed
 * text. Inventing one moves every future message for that customer into a
 * window nobody asked for, and nothing downstream questions it, because a
 * stated constraint is supposed to outrank the default.
 *
 * So the must-not-fire block below is the more important half of this file.
 */

describe("constraints the customer actually stated", () => {
  it.each([
    ["I'm at work until 5", 0, 17],
    ["at work til 5pm", 0, 17],
    ["Can't talk until 6", 0, 18],
    ["I'm busy until 5:30pm", 0, 17],
    ["I work 9-5", 9, 17],
    ["I work 8 to 4", 8, 16],
    ["Only free after 6", 0, 18],
    ["best to text after 7pm", 0, 19],
  ])("%j blocks %i:00 to %i:00", (text, startHour, endHour) => {
    expect(statedConstraint(text)).toEqual({ startHour, endHour });
  });

  it.each([
    ["please don't text me during the day", 9, 17],
    ["don't call me at work", 9, 17],
    ["can't do mornings, I work then", 6, 12],
    ["afternoons don't work for me, I'm at the office", 12, 17],
  ])("%j blocks %i:00 to %i:00", (text, startHour, endHour) => {
    expect(statedConstraint(text)).toEqual({ startHour, endHour });
  });

  it("reads a bare evening hour as the evening", () => {
    // "back at 6" is six in the evening. Nobody means 6am.
    expect(statedConstraint("I'm at work until 6")).toEqual({ startHour: 0, endHour: 18 });
  });
});

/**
 * THE HALF THAT MATTERS MORE.
 *
 * Every one of these is a real thing a painting customer says, and inventing a
 * constraint from any of them would silently reschedule the rest of the
 * conversation.
 */
describe("what it refuses to treat as a constraint", () => {
  it.each([
    "We need it done until the end of May",
    "The fence is 5 feet",
    "Yes",
    "I have 3 rooms, about 500 square feet",
    "We're looking to paint before 10 guests arrive",
    "Can you do it for under 5000",
    "Quote was 4 to 5 thousand",
    "The house is at 9 Mill Road",
    "until further notice",
    "",
  ])("ignores %j", (text) => {
    expect(statedConstraint(text)).toBeNull();
  });

  it("ignores a time with no reachability word anywhere", () => {
    expect(statedConstraint("until 5")).toBeNull();
    expect(statedConstraint("after 6")).toBeNull();
  });

  it("does not read plain availability as a refusal", () => {
    // "mornings work great" is the OPPOSITE of a constraint, and blocking
    // mornings on it would be the worst possible reading.
    expect(statedConstraint("mornings work great for me")).toBeNull();
    expect(statedConstraint("I'm free in the afternoon")).toBeNull();
  });

  /**
   * THE CASES THE REAL CORPUS FORCED.
   *
   * Every one of these was detected, wrongly, by the first version of this
   * parser when it was run over the 332 customer messages in Kate's 1,234
   * conversations. They are kept as tests because they are the reason the
   * parser is shaped the way it is.
   */
  it.each([
    // The inversion: their stated AVAILABILITY read as a blocked window.
    "Anytime 9am - 6:30 pm works",
    "I think anytime next week in the morning/early afternoon after 10 am should work",
    "For a walkthrough or a call? Anytime for a call. Walkthrough Tuesday anytime after 12",
    // A date range read as hours.
    "Hi! I am looking for someone to spec and quote my home September 11-13?",
    // An iMessage reaction quoting OUR message back at us.
    'Loved "Good morning! We truly apologize that no one showed up for your appointment"',
  ])("refuses %j, which it used to get wrong", (text) => {
    expect(statedConstraint(text)).toBeNull();
  });

  it("refuses a bare range with no pronoun, deliberately", () => {
    // "office hours are 9 to 5" is a real constraint and this misses it. That
    // is the trade taken on purpose: missing one costs a badly timed text,
    // while a loose range pattern inverted a customer's availability on the
    // real corpus. Precision wins here because the failure is silent.
    expect(statedConstraint("office hours are 9 to 5")).toBeNull();
  });

  it("ignores an absurdly long message", () => {
    expect(statedConstraint("I can't text until 5. " + "x".repeat(700))).toBeNull();
  });
});

describe("which hours are ruled out", () => {
  const win = { startHour: 9, endHour: 17 };

  it("is half open, so the end hour is reachable", () => {
    expect(blocked(9, win)).toBe(true);
    expect(blocked(16, win)).toBe(true);
    expect(blocked(17, win)).toBe(false);
    expect(blocked(8, win)).toBe(false);
  });

  it("blocks nothing when nothing was stated", () => {
    expect(blocked(10, null)).toBe(false);
  });
});

describe("where the follow-up moves to", () => {
  // A36's outbound window. A44 sets the rhythm, A36 sets the hours, and
  // where they disagree A36 wins.
  const bounds = { startHour: 8, endHour: 21 };

  it("leaves a time that was never blocked alone", () => {
    expect(reachableHour({ startHour: 9, endHour: 17 }, 18, bounds)).toBe(18);
  });

  it("moves a blocked 10 AM to just after the window", () => {
    // The customer said they are at work until 5, so the day-1 follow-up at
    // 10 AM becomes 5 PM rather than being sent into their workday.
    expect(reachableHour({ startHour: 0, endHour: 17 }, 10, bounds)).toBe(17);
  });

  it("prefers the same evening over sliding a day", () => {
    expect(reachableHour({ startHour: 9, endHour: 17 }, 15, bounds)).toBe(17);
  });

  it("falls back to before the window when it runs to the end of the day", () => {
    // "don't text me after 6" leaves the morning.
    expect(reachableHour({ startHour: 18, endHour: 23 }, 19, bounds)).toBe(17);
  });

  it("gives up when the whole sendable day is ruled out", () => {
    // Kate's "or to a Saturday" — the caller moves the day, not the hour.
    expect(reachableHour({ startHour: 0, endHour: 23 }, 10, bounds)).toBeNull();
  });

  it("never returns an hour outside A36's window", () => {
    for (let start = 0; start < 23; start++) {
      for (let end = start + 1; end <= 23; end++) {
        for (const preferred of [10, 15, 18]) {
          const h = reachableHour({ startHour: start, endHour: end }, preferred, bounds);
          if (h === null) continue;
          expect(h).toBeGreaterThanOrEqual(bounds.startHour);
          expect(h).toBeLessThan(bounds.endHour);
          expect(blocked(h, { startHour: start, endHour: end })).toBe(false);
        }
      }
    }
  });
});
