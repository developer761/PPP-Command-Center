import { describe, it, expect } from "vitest";
import { afterHoursReply, AFTER_HOURS_INTENT } from "@/lib/messaging/after-hours";

/**
 * The toggle has been on the Settings screen since workspace hours were built,
 * saved by the form, read back into the form, and consumed by nothing. Two
 * other screens advertise "after-hours replies" as a working feature.
 */
const WS = {
  after_hours_autoreply: true,
  after_hours_message: "Thanks for reaching out! The office is closed right now — we'll get back to you first thing.",
  time_zone: "America/New_York",
  quiet_hours_start: 9,
  quiet_hours_end: 20,
};

/** A local New York hour, as UTC. EDT in September is UTC-4. */
const nyc = (hour: number) => new Date(Date.UTC(2026, 8, 22, hour + 4, 0));

const decide = (over: Partial<Parameters<typeof afterHoursReply>[0]> = {}) =>
  afterHoursReply({ workspace: WS, now: nyc(21), alreadySentToday: 0, keyword: null, ...over });

describe("when somebody texts out of hours", () => {
  it("answers at half past eight in the evening", () => {
    // The case the feature exists for: the office shut at 8, they texted at
    // 8:30, and silence until morning reads as nobody being there at all.
    const d = decide({ now: new Date(Date.UTC(2026, 8, 22, 20 + 4, 30)) });
    expect(d.send).toBe(true);
    expect(d.send && d.body).toMatch(/office is closed/i);
  });

  it("answers early in the morning, before the office opens", () => {
    expect(decide({ now: nyc(8) }).send).toBe(true);
  });

  it("stays silent at two in the morning", () => {
    // Outside the federal 8am-9pm window. They get a real answer when the
    // agent turn runs, rather than a text in the middle of the night.
    const d = decide({ now: nyc(2) });
    expect(d.send).toBe(false);
    expect(d.send === false && d.why).toMatch(/federal/i);
  });

  it("stays silent at ten at night", () => {
    expect(decide({ now: nyc(22) }).send).toBe(false);
  });

  it("says nothing while the office is open — the ordinary reply covers it", () => {
    const d = decide({ now: nyc(14) });
    expect(d.send).toBe(false);
    expect(d.send === false && d.why).toMatch(/open/i);
  });
});

describe("once per person per day", () => {
  it("does not send a second one", () => {
    // Five texts at midnight is somebody talking to themselves. Five identical
    // "we are closed" replies is worse than none.
    const d = decide({ alreadySentToday: 1 });
    expect(d.send).toBe(false);
    expect(d.send === false && d.why).toMatch(/already/i);
  });
});

describe("what it must never answer instead of", () => {
  it("leaves STOP alone", () => {
    // Somebody saying stop gets suppressed, not chatted to.
    expect(decide({ keyword: "opt_out" }).send).toBe(false);
  });

  it("leaves HELP alone, which has its own required reply", () => {
    expect(decide({ keyword: "help" }).send).toBe(false);
  });

  it("leaves START alone", () => {
    expect(decide({ keyword: "opt_in" }).send).toBe(false);
  });
});

describe("configuration it refuses to guess at", () => {
  it("is off unless somebody switched it on", () => {
    expect(decide({ workspace: { ...WS, after_hours_autoreply: false } }).send).toBe(false);
    expect(decide({ workspace: { ...WS, after_hours_autoreply: null } }).send).toBe(false);
  });

  it("will not send an empty message just because the toggle is on", () => {
    const d = decide({ workspace: { ...WS, after_hours_message: "   " } });
    expect(d.send).toBe(false);
    expect(d.send === false && d.why).toMatch(/no after-hours message/i);
  });

  it("says nothing when the workspace has no timezone", () => {
    // Without one there is no such thing as "out of hours" for them, and the
    // gate refuses the send anyway rather than guessing.
    const d = decide({ workspace: { ...WS, time_zone: null } });
    expect(d.send).toBe(false);
    expect(d.send === false && d.why).toMatch(/timezone/i);
  });
});

describe("the marker", () => {
  it("is a stable string, because the daily count is keyed on it", () => {
    expect(AFTER_HOURS_INTENT).toBe("after_hours");
  });
});
