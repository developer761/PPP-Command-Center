import { describe, it, expect } from "vitest";
import { scheduleSteps, type CampaignStep } from "@/lib/messaging/campaign-schedule";
import { statedConstraint } from "@/lib/messaging/reachability";

/**
 * A44: "A STATED CONSTRAINT MOVES THE CADENCE."
 *
 * The constraint is read off the customer's message, stored on the
 * conversation because it never expires, and applied to the day-based
 * follow-ups. This is the whole path, end to end, with only the database
 * missing.
 */

const TZ = "America/New_York";

/** The cadence as configured today: day 1 and day 3, both at 10:00. */
const steps: CampaignStep[] = [
  { ordinal: 1, scheduleMode: "at_launch", delayMinutes: null, dayOffset: null, timeOfDay: null, channel: "sms", body: "opener", subject: null },
  { ordinal: 3, scheduleMode: "absolute_on_day", delayMinutes: null, dayOffset: 1, timeOfDay: "10:00:00", channel: "sms", body: "day 1", subject: null },
  { ordinal: 4, scheduleMode: "absolute_on_day", delayMinutes: null, dayOffset: 3, timeOfDay: "10:00:00", channel: "sms", body: "day 3", subject: null },
];

const enrolled = new Date("2026-09-22T14:00:00Z"); // 10:00 EDT

/** Local hour of a scheduled instant, in the customer's timezone. */
const hourIn = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d));

describe("a follow-up does not land in a window the customer ruled out", () => {
  it("leaves the cadence alone when nothing was stated", () => {
    const out = scheduleSteps(steps, enrolled, TZ);
    expect(out.filter((s) => s.ordinal !== 1).map((s) => hourIn(s.runAt, TZ))).toEqual([10, 10]);
  });

  it("moves every day-based follow-up out of the customer's workday", () => {
    // "I'm at work until 5" — every 10 AM follow-up becomes 5 PM.
    const win = statedConstraint("I'm at work until 5");
    expect(win).toEqual({ startHour: 0, endHour: 17 });

    const out = scheduleSteps(steps, enrolled, TZ, { unreachable: win });
    const hours = out.filter((s) => s.ordinal !== 1).map((s) => hourIn(s.runAt, TZ));
    expect(hours).toEqual([17, 17]);
  });

  it("binds EVERY follow-up, not just the next one", () => {
    // "once stated, it binds the whole cadence" — the day-3 message is a week
    // of silence later and still moves.
    const win = statedConstraint("please don't text me during the day");
    const out = scheduleSteps(steps, enrolled, TZ, { unreachable: win });
    for (const s of out.filter((x) => x.ordinal !== 1)) {
      const h = hourIn(s.runAt, TZ);
      expect(h >= 9 && h < 17).toBe(false);
    }
  });

  it("does not move the opener", () => {
    // The opener is anchored to enrolment. Moving it would change what it is,
    // and a lead is answered in 2 to 5 minutes whatever they later say.
    const win = statedConstraint("I'm at work until 5");
    const a = scheduleSteps(steps, enrolled, TZ);
    const b = scheduleSteps(steps, enrolled, TZ, { unreachable: win });
    expect(b[0].runAt.toISOString()).toBe(a[0].runAt.toISOString());
  });

  it("keeps the day, only moves the hour", () => {
    // A44 sets the rhythm. One per day is the rhythm.
    const win = statedConstraint("I'm at work until 5");
    const plain = scheduleSteps(steps, enrolled, TZ);
    const moved = scheduleSteps(steps, enrolled, TZ, { unreachable: win });
    const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
    for (let i = 0; i < plain.length; i++) {
      expect(dayOf(moved[i].runAt)).toBe(dayOf(plain[i].runAt));
    }
  });

  it("never schedules outside the federal window", () => {
    // A44 sets the rhythm, A36 sets the hours, and where they disagree A36
    // wins. Nothing this produces may sit outside 8am-9pm local.
    for (const text of [
      "I'm at work until 5", "don't text me during the day",
      "can't talk until 6", "I work 9-5", "afternoons don't work, I'm at the office",
    ]) {
      const win = statedConstraint(text);
      const out = scheduleSteps(steps, enrolled, TZ, { unreachable: win });
      for (const s of out.filter((x) => x.ordinal !== 1)) {
        const h = hourIn(s.runAt, TZ);
        expect(h).toBeGreaterThanOrEqual(8);
        expect(h).toBeLessThan(21);
      }
    }
  });

  it("keeps the intended hour when the whole day is ruled out", () => {
    // The gate defers it rather than this inventing a day nobody asked for.
    const out = scheduleSteps(steps, enrolled, TZ, { unreachable: { startHour: 0, endHour: 24 } });
    expect(out.filter((s) => s.ordinal !== 1).map((s) => hourIn(s.runAt, TZ))).toEqual([10, 10]);
  });
});

/**
 * PROVE IT CAN FAIL: the shift is real, not a no-op that happens to agree.
 */
describe("the shift is doing something", () => {
  it("produces a different schedule than no constraint at all", () => {
    const win = statedConstraint("I'm at work until 5");
    const a = scheduleSteps(steps, enrolled, TZ).map((s) => s.runAt.toISOString());
    const b = scheduleSteps(steps, enrolled, TZ, { unreachable: win }).map((s) => s.runAt.toISOString());
    expect(b).not.toEqual(a);
  });
});
