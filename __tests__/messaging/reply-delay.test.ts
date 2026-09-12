import { describe, it, expect } from "vitest";
import {
  pickDelaySeconds, delayedRunAt, validateDelay, describeDelay,
  isDelayOff, MAX_DELAY_SECONDS,
} from "@/lib/messaging/reply-delay";
import fs from "node:fs";

const TZ = "America/New_York";
const HOURS = { startHour: 9, endHour: 20 };
const at = (iso: string) => new Date(iso);

describe("off by default", () => {
  it("both bounds at zero is off", () => {
    expect(isDelayOff({ minSeconds: 0, maxSeconds: 0 })).toBe(true);
    expect(pickDelaySeconds({ minSeconds: 0, maxSeconds: 0 })).toBe(0);
  });

  it("off means the turn runs now, unchanged", () => {
    const now = at("2026-09-14T18:00:00Z"); // 2pm ET, well inside the window
    const out = delayedRunAt({ now, config: { minSeconds: 0, maxSeconds: 0 }, timeZone: TZ, quietHours: HOURS });
    expect(out.getTime()).toBe(now.getTime());
  });
});

describe("the draw", () => {
  it("can produce both ends of the range", () => {
    // A range of 120-300 that can never return 120 or 300 is not the range
    // somebody typed.
    expect(pickDelaySeconds({ minSeconds: 120, maxSeconds: 300 }, () => 0)).toBe(120);
    expect(pickDelaySeconds({ minSeconds: 120, maxSeconds: 300 }, () => 0.999999)).toBe(300);
  });

  it("stays inside the range over many draws", () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const v = pickDelaySeconds({ minSeconds: 120, maxSeconds: 300 });
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(120);
    expect(hi).toBeLessThanOrEqual(300);
  });

  it("is not the same number every time — that is the whole point", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(pickDelaySeconds({ minSeconds: 120, maxSeconds: 300 }));
    expect(seen.size).toBeGreaterThan(10);
  });

  it("an inverted range is read as a range, not as off", () => {
    // The database refuses this, but a row written before the constraint, or
    // by hand, must not silently disable the feature the way an inverted
    // quiet-hours window once disabled a whole workspace.
    const v = pickDelaySeconds({ minSeconds: 300, maxSeconds: 120 }, () => 0.5);
    expect(v).toBeGreaterThanOrEqual(120);
    expect(v).toBeLessThanOrEqual(300);
  });

  it("never exceeds the cap even if the row somehow does", () => {
    expect(pickDelaySeconds({ minSeconds: 0, maxSeconds: 99999 }, () => 0.999999))
      .toBeLessThanOrEqual(MAX_DELAY_SECONDS);
  });
});

describe("the delay never pushes a reply into tomorrow", () => {
  it("drops the delay when it would cross the quiet-hours boundary", () => {
    // 8:58pm ET, window closes at 8pm... so use a time just inside a 9pm close.
    const now = at("2026-09-15T00:58:00Z"); // 8:58pm ET on the 14th
    const out = delayedRunAt({
      now,
      config: { minSeconds: 300, maxSeconds: 300 },
      timeZone: TZ,
      quietHours: { startHour: 9, endHour: 21 }, // closes 9pm
    });
    // 9:03pm would be refused by the gate and answered at 9am tomorrow. A reply
    // now is both lawful and eleven hours sooner.
    expect(out.getTime()).toBe(now.getTime());
  });

  it("applies the delay normally in the middle of the day", () => {
    const now = at("2026-09-14T18:00:00Z"); // 2pm ET
    const out = delayedRunAt({
      now, config: { minSeconds: 300, maxSeconds: 300 }, timeZone: TZ, quietHours: HOURS,
    });
    expect(out.getTime()).toBe(now.getTime() + 300_000);
  });

  it("does not invent a send window when we are already outside one", () => {
    // 3am ET. The gate will defer this regardless; the delay must not pretend
    // it can help by returning now.
    const now = at("2026-09-14T07:00:00Z");
    const out = delayedRunAt({
      now, config: { minSeconds: 300, maxSeconds: 300 }, timeZone: TZ, quietHours: HOURS,
    });
    expect(out.getTime()).toBe(now.getTime() + 300_000);
  });
});

describe("what somebody typed", () => {
  it("accepts a sensible range", () => {
    expect(validateDelay(120, 300)).toBeNull();
    expect(validateDelay(0, 0)).toBeNull();
  });

  it("refuses the things the constraint refuses, in words", () => {
    expect(validateDelay(-1, 300)).toMatch(/negative/i);
    expect(validateDelay(300, 120)).toMatch(/at least/i);
    expect(validateDelay(0, 99999)).toMatch(/thirty minutes/i);
    expect(validateDelay(1.5, 300)).toMatch(/whole seconds/i);
  });

  it("the code cap and the database cap are the same number", () => {
    const sql = fs.readdirSync("supabase/migrations")
      .filter((f) => f.endsWith("_reply_delay.sql"))
      .map((f) => fs.readFileSync(`supabase/migrations/${f}`, "utf8")).join("");
    expect(sql).toContain(String(MAX_DELAY_SECONDS));
  });
});

describe("how it reads on a screen", () => {
  it("says what it does", () => {
    expect(describeDelay({ minSeconds: 0, maxSeconds: 0 })).toMatch(/straight away/i);
    expect(describeDelay({ minSeconds: 120, maxSeconds: 300 })).toBe("Waits 2 min–5 min");
    expect(describeDelay({ minSeconds: 180, maxSeconds: 180 })).toBe("Waits 3 min");
  });
});
