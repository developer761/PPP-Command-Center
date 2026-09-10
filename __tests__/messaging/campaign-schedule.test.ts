import { describe, it, expect } from "vitest";
import { scheduleSteps, parseTimeOfDay, localTimeOnDay, type CampaignStep } from "@/lib/messaging/campaign-schedule";

const NY = "America/New_York";
const step = (o: Partial<CampaignStep> & { ordinal: number }): CampaignStep => ({
  scheduleMode: "at_launch", delayMinutes: null, dayOffset: null, timeOfDay: null,
  channel: "sms", body: "hello", subject: null, ...o,
});

/** 10am on a September day in New York is 14:00 UTC. */
const ENROLLED = new Date("2026-09-10T14:00:00Z");

describe("when each step goes out", () => {
  it("sends the opener the moment somebody enters", () => {
    const [first] = scheduleSteps([step({ ordinal: 1 })], ENROLLED, NY);
    expect(first.runAt.toISOString()).toBe(ENROLLED.toISOString());
  });

  it("stacks a delay on the step before it, not on enrolment", () => {
    const out = scheduleSteps([
      step({ ordinal: 1 }),
      step({ ordinal: 2, scheduleMode: "delay_after_last", delayMinutes: 60 }),
      step({ ordinal: 3, scheduleMode: "delay_after_last", delayMinutes: 60 }),
    ], ENROLLED, NY);
    expect(out[1].runAt.toISOString()).toBe("2026-09-10T15:00:00.000Z");
    expect(out[2].runAt.toISOString()).toBe("2026-09-10T16:00:00.000Z");
  });

  it("puts an absolute step at that local time on that day", () => {
    const [s] = scheduleSteps(
      [step({ ordinal: 1, scheduleMode: "absolute_on_day", dayOffset: 2, timeOfDay: "10:00" })],
      ENROLLED, NY
    );
    // 10am New York, two days on, is 14:00 UTC while daylight saving holds.
    expect(s.runAt.toISOString()).toBe("2026-09-12T14:00:00.000Z");
  });

  /**
   * New York is four hours behind in September and five in December. A step
   * scheduled across that boundary would otherwise land an hour out for half
   * the year.
   */
  it("still means 10am after the clocks change", () => {
    const at = localTimeOnDay(new Date("2026-10-25T14:00:00Z"), 14, 10 * 60, NY);
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: NY, hour: "numeric", hour12: false,
    }).format(at);
    expect(Number(localHour) % 24).toBe(10);
  });

  it("never lets a step arrive before the one in front of it", () => {
    const out = scheduleSteps([
      step({ ordinal: 1, scheduleMode: "delay_after_last", delayMinutes: 60 * 24 * 6 }),
      step({ ordinal: 2, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "09:00" }),
    ], ENROLLED, NY);
    expect(out[1].runAt.getTime()).toBeGreaterThanOrEqual(out[0].runAt.getTime());
  });

  it("orders by ordinal, whatever order the rows arrive in", () => {
    const out = scheduleSteps([
      step({ ordinal: 3, scheduleMode: "delay_after_last", delayMinutes: 10 }),
      step({ ordinal: 1 }),
      step({ ordinal: 2, scheduleMode: "delay_after_last", delayMinutes: 10 }),
    ], ENROLLED, NY);
    expect(out.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  /**
   * An unreadable time would schedule at midnight — the one hour the gate will
   * not send in — so the step would sit deferred until 9am and look broken.
   */
  it("does not silently schedule a broken time at midnight", () => {
    const out = scheduleSteps([
      step({ ordinal: 1 }),
      step({ ordinal: 2, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "not a time" }),
    ], ENROLLED, NY);
    expect(out[1].runAt.toISOString()).toBe(ENROLLED.toISOString());
  });

  it("reads the time formats the column can hold", () => {
    expect(parseTimeOfDay("09:00")).toBe(540);
    expect(parseTimeOfDay("09:00:00")).toBe(540);
    expect(parseTimeOfDay("9:05")).toBe(545);
    expect(parseTimeOfDay("23:59")).toBe(1439);
  });

  it("refuses a time that is not one", () => {
    for (const t of ["24:00", "10:60", "", "abc", null]) {
      expect(parseTimeOfDay(t), String(t)).toBeNull();
    }
  });

  it("survives a timezone it does not know rather than throwing", () => {
    expect(() => scheduleSteps(
      [step({ ordinal: 1, scheduleMode: "absolute_on_day", dayOffset: 1, timeOfDay: "10:00" })],
      ENROLLED, "Not/AZone"
    )).not.toThrow();
  });

  it("returns nothing for a campaign with no steps", () => {
    expect(scheduleSteps([], ENROLLED, NY)).toEqual([]);
  });
});
