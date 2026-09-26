/**
 * A40's other half: when the bot comes back.
 *
 * The spec: "What has never once happened is the bot coming back. That half
 * is untested in the corpus, so expect to adjudicate the first few." So the
 * negatives below matter more than the positives — reading a time WRONG
 * re-opens a conversation at a moment the customer did not ask for, which is
 * a nag delivered by the mechanism meant to honour their request.
 */
import { describe, it, expect } from "vitest";
import {
  namedReturnDay, parkReopenAt, REOPEN_HOUR, MAX_PARK_DAYS,
} from "@/lib/messaging/park-time";
import { sendingWindow } from "@/lib/messaging/sending-window";

// Thursday 2026-09-24, so "the 15th" is behind them and must roll forward.
const TODAY = { year: 2026, month: 9, day: 24 };
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const NOW = new Date("2026-09-24T14:00:00Z");

const day = (t: string) => namedReturnDay(t, TODAY);

describe("dates the customer actually named", () => {
  it("reads 'after the 15th' as next month, since the 15th has passed", () => {
    expect(day("call me after the 15th")).toEqual({ year: 2026, month: 10, day: 15 });
  });

  it("reads 'the 28th' as this month, since it is still ahead", () => {
    expect(day("I'll know more by the 28th")).toEqual({ year: 2026, month: 9, day: 28 });
  });

  it("reads tomorrow", () => {
    expect(day("try me tomorrow")).toEqual({ year: 2026, month: 9, day: 25 });
  });

  it("reads next week and 'in two weeks'", () => {
    expect(day("get back to me next week")).toEqual({ year: 2026, month: 10, day: 1 });
    expect(day("in two weeks")).toEqual({ year: 2026, month: 10, day: 8 });
    expect(day("in a couple of weeks")).toEqual({ year: 2026, month: 10, day: 8 });
  });

  it("reads 'in 10 days'", () => {
    expect(day("check back in 10 days")).toEqual({ year: 2026, month: 10, day: 4 });
  });

  it("reads next month", () => {
    expect(day("next month is better")).toEqual({ year: 2026, month: 10, day: 24 });
  });

  it("reads a named month as its first", () => {
    expect(day("we're thinking March")).toEqual({ year: 2027, month: 3, day: 1 });
  });

  it("reads a weekday as the NEXT one, never today", () => {
    // 2026-09-24 is a Thursday.
    expect(day("call me Monday")).toEqual({ year: 2026, month: 9, day: 28 });
    expect(day("Thursday works")).toEqual({ year: 2026, month: 10, day: 1 });   // not today
    expect(day("next Friday")).toEqual({ year: 2026, month: 10, day: 2 });       // not tomorrow
  });
});

describe("what it deliberately refuses to guess", () => {
  /**
   * Each of these was considered and left out. A park with no reminder is
   * where we were before this existed; a park with the WRONG reminder is a
   * bot nagging somebody who already said they would come back.
   */
  for (const t of [
    "once I've spoken to my wife",     // the no-time case — PPP's to decide
    "in a few days",                   // a few is not a number
    "after the holidays",              // which holidays, whose
    "I'll get back to you soon",
    "later",
    "let me think about it",
    "give me some time",
    "",
  ]) {
    it(`${JSON.stringify(t)} names no day`, () => {
      expect(day(t)).toBeNull();
    });
  }

  it("a bare number is not a date", () => {
    // "15" alone could be anything — a house number, a quantity, a price.
    expect(day("about 15")).toBeNull();
    expect(day("15")).toBeNull();
  });
});

describe("the instant it re-opens at", () => {
  const at = (t: string, zone = NY) =>
    parkReopenAt({ text: t, today: TODAY, customerZone: zone, notBefore: NOW });

  it("lands at 10am on the customer's own clock", () => {
    const d = at("after the 15th")!;
    expect(d).not.toBeNull();
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hour12: false }).format(d)) % 24;
    expect(h).toBe(REOPEN_HOUR);
  });

  it("uses the CUSTOMER's clock, not ours", () => {
    const east = at("after the 15th", NY)!;
    const west = at("after the 15th", LA)!;
    // Same local hour, three hours apart in absolute terms.
    expect(west.getTime() - east.getTime()).toBe(3 * 3600_000);
  });

  /**
   * A re-open is an outbound message the bot initiates, so it obeys A36's
   * callback window exactly as a stall follow-up does — through the SAME
   * function, so the two cannot drift.
   */
  it("never schedules outside A36's window", () => {
    for (const zone of [NY, LA, "America/Chicago", "America/Denver"]) {
      for (const t of ["after the 15th", "next week", "tomorrow", "Monday", "in 10 days"]) {
        const d = parkReopenAt({ text: t, today: TODAY, customerZone: zone, notBefore: NOW });
        if (!d) continue;
        expect(sendingWindow({ now: d, customerZone: zone }).open, `${zone} "${t}" -> ${d.toISOString()}`).toBe(true);
      }
    }
  });

  it("shifts around a window the customer said they are unreachable in", () => {
    const d = parkReopenAt({
      text: "after the 15th", today: TODAY, customerZone: NY, notBefore: NOW,
      unreachable: { startHour: 9, endHour: 17 },
    })!;
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hour12: false }).format(d)) % 24;
    expect(h < 9 || h >= 17).toBe(true);
  });

  it("is always in the future", () => {
    for (const t of ["tomorrow", "Monday", "after the 15th", "next week"]) {
      const d = parkReopenAt({ text: t, today: TODAY, customerZone: NY, notBefore: NOW });
      if (d) expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("refuses a park further out than we will hold a thread", () => {
    // A named month more than MAX_PARK_DAYS away.
    const far = parkReopenAt({ text: "we're thinking August", today: TODAY, customerZone: NY, notBefore: NOW });
    expect(far).toBeNull();
    expect(MAX_PARK_DAYS).toBe(120);
  });

  it("returns null when no day was named, so the park simply has no reminder", () => {
    expect(at("once I've spoken to my wife")).toBeNull();
  });
});
