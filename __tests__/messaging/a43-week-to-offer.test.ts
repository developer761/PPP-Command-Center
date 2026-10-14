import { describe, it, expect } from "vitest";
import { weekToOffer, askAvailability, askAvailabilityEs } from "@/lib/messaging/availability-ask";

/**
 * A43, live and critical: "Offer the week the day rule calls for." Kate's
 * corrective action names the cut exactly — "offered openings this week
 * (Sun-Wed) or next week (Thu-Sat) and asked what works best".
 *
 * The behaviour was correct when this was written. Nothing tested it: a
 * survey of which live rules have checks naming them put A43 at zero, the
 * only critical rule with code and no test. So the rule held by luck rather
 * than by anything that would notice it breaking.
 *
 * Dates below are real: 2026-10-11 was a Sunday.
 */
const TZ = "America/New_York";
/** Noon ET on the Nth day after Sunday 2026-10-11, well clear of any boundary. */
const noonET = (offsetDays: number) => new Date(Date.UTC(2026, 9, 11 + offsetDays, 16, 0, 0));

describe("A43 — which week the availability ask offers", () => {
  it.each([
    ["Sunday", 0, "this"],
    ["Monday", 1, "this"],
    ["Tuesday", 2, "this"],
    ["Wednesday", 3, "this"],
    ["Thursday", 4, "next"],
    ["Friday", 5, "next"],
    ["Saturday", 6, "next"],
  ] as const)("%s offers %s week", (_day, offset, want) => {
    expect(weekToOffer(noonET(offset), TZ)).toBe(want);
  });

  /**
   * The cut itself, which is the only part that can silently drift. Wednesday
   * is the last day of "this week" and Thursday the first of "next" — stated
   * as a pair so an off-by-one moves both and fails loudly.
   */
  it("cuts between Wednesday and Thursday, not anywhere else", () => {
    expect(weekToOffer(noonET(3), TZ)).toBe("this");
    expect(weekToOffer(noonET(4), TZ)).toBe("next");
  });

  /**
   * The zone is the CUSTOMER's. Late Wednesday in New York is already
   * Thursday in UTC, and reading the wrong one would offer the wrong week to
   * everybody on the east coast every Wednesday evening.
   */
  it("reads the day in the customer's zone, not UTC", () => {
    // 2026-10-14 03:00 UTC is Tuesday 11pm in New York.
    const lateTuesdayET = new Date(Date.UTC(2026, 9, 14, 3, 0, 0));
    expect(weekToOffer(lateTuesdayET, TZ)).toBe("this");
    expect(weekToOffer(lateTuesdayET, "America/Los_Angeles")).toBe("this");
  });

  /** Both languages say which week, and neither claims a specific opening. */
  it("names the week without inventing an opening", () => {
    for (const week of ["this", "next"] as const) {
      for (const text of [askAvailability(week), askAvailabilityEs(week)]) {
        expect(text).toMatch(week === "this" ? /this week|esta semana/i : /next week|próxima semana/i);
        // A35/A1: no specific day, hour or claim that we HAVE an opening.
        expect(text).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
        expect(text).not.toMatch(/\bwe have\b|\btenemos\b/i);
      }
    }
  });
});
