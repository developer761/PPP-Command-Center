import { describe, it, expect } from "vitest";
import { startOfDayIn } from "@/lib/messaging/gate";

/**
 * Where the daily cap's day begins.
 *
 * The cap counts what has gone to a handset since the start of the recipient's
 * own calendar day, and the gate hands that instant to the counting dep so the
 * window it counts and the day it defers to are the same day. Getting the
 * boundary an hour wrong counts yesterday evening's messages against this
 * morning, which holds a message for a day — or misses this morning's, which
 * sends a fourth.
 *
 * The obvious implementation — read the local clock and subtract it — is wrong
 * on the two days a year a zone shifts, because the offset at midnight is not
 * the offset now. These assert the property directly rather than through the
 * gate: no fixture can reach a 00:30 send, since no rule in the system would
 * ever let one out at that hour, and an untested edge in a helper outlives
 * whichever rule is currently covering for it.
 */

const fmt = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);

const ZONES = [
  "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Phoenix", "Pacific/Honolulu",
  // Not a PPP zone today, and that is the point: a half-hour offset is where
  // stepping in whole hours would land inside yesterday.
  "Asia/Kolkata",
];

describe("startOfDayIn", () => {
  it("returns local midnight, in every zone, at every hour of a day", () => {
    for (const zone of ZONES) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 6, 15, h, 37, 12));
        const start = startOfDayIn(now, zone);
        expect(fmt(start, zone).slice(-5), `${zone} @ ${h}:37 UTC`).toBe("00:00");
        // Same day as now, and never in the future.
        expect(fmt(start, zone).slice(0, 10)).toBe(fmt(now, zone).slice(0, 10));
        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      }
    }
  });

  it("is still local midnight on the day the clocks go forward", () => {
    // US DST began 2026-03-08: 2am EST became 3am EDT.
    for (let h = 7; h < 24; h++) {
      const now = new Date(Date.UTC(2026, 2, 8, h, 15, 0));
      const start = startOfDayIn(now, "America/New_York");
      expect(fmt(start, "America/New_York"), `${h}:15 UTC`).toBe("03/08/2026, 00:00");
    }
  });

  it("is still local midnight on the day the clocks go back", () => {
    // US DST ended 2026-11-01: 2am EDT became 1am EST, so the local day is 25
    // hours long and the 1am hour happens twice.
    for (let h = 4; h < 24; h++) {
      const now = new Date(Date.UTC(2026, 10, 1, h, 15, 0));
      const start = startOfDayIn(now, "America/New_York");
      expect(fmt(start, "America/New_York"), `${h}:15 UTC`).toBe("11/01/2026, 00:00");
    }
  });

  it("never reaches back further than one long day", () => {
    for (const zone of ZONES) {
      for (const iso of ["2026-03-08T12:00:00Z", "2026-11-01T12:00:00Z", "2026-07-15T12:00:00Z"]) {
        const now = new Date(iso);
        const back = now.getTime() - startOfDayIn(now, zone).getTime();
        expect(back, `${zone} ${iso}`).toBeLessThan(25 * 3600_000);
        expect(back).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
