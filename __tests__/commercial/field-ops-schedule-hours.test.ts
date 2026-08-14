import { describe, it, expect } from "vitest";
import { hoursBetween } from "@/lib/commercial/field-ops/schedule";

/**
 * FO5 regression: a night shift crosses midnight, so the end time is EARLIER
 * than the start. hoursBetween used to return null for end<=start, which meant a
 * night shift couldn't be scheduled (and got no reminders). It now treats an
 * earlier end as the next day, matching clock.ts's elapsed-span punches.
 */
describe("hoursBetween", () => {
  it("computes a normal daytime shift", () => {
    expect(hoursBetween("08:00", "16:30")).toBe(8.5);
  });

  it("handles a night shift that crosses midnight (22:00 → 06:00 = 8h)", () => {
    expect(hoursBetween("22:00", "06:00")).toBe(8);
  });

  it("handles just-past-midnight (23:45 → 00:15 = 0.5h)", () => {
    expect(hoursBetween("23:45", "00:15")).toBe(0.5);
  });

  it("rejects equal start/end (zero-length / ambiguous 24h)", () => {
    expect(hoursBetween("08:00", "08:00")).toBeNull();
  });

  it("rounds to the quarter hour", () => {
    expect(hoursBetween("09:00", "17:10")).toBe(8.25);
  });

  it("returns null on unparseable input", () => {
    expect(hoursBetween("", "16:00")).toBeNull();
    expect(hoursBetween("08:00", null)).toBeNull();
  });
});
