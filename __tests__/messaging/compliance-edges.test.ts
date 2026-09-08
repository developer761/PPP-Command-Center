import { describe, it, expect } from "vitest";
import { withinQuietHours, localHour, clampToFederal, FEDERAL_BOUND } from "@/lib/messaging/compliance";

/**
 * Found by throwing hostile input at the real modules rather than by a test
 * written from the same assumptions as the code.
 */
describe("hours, when the data is wrong", () => {
  /**
   * Intl throws on a zone it does not know. That used to propagate out of the
   * gate, so one workspace row with a typo turned every send for that
   * workspace into an unexplained exception that retried forever.
   */
  it("does not throw on a timezone that does not exist", () => {
    expect(() => withinQuietHours(new Date(), "Not/AZone", { startHour: 9, endHour: 20 })).not.toThrow();
    expect(() => localHour(new Date(), "Not/AZone")).not.toThrow();
  });

  it("refuses to send when it cannot tell what time it is there", () => {
    // False means outside the window means do not send. Not knowing the hour
    // is not permission to guess.
    expect(withinQuietHours(new Date(), "Not/AZone", { startHour: 9, endHour: 20 })).toBe(false);
    expect(withinQuietHours(new Date(), "", { startHour: 9, endHour: 20 })).toBe(false);
    expect(localHour(new Date(), "Not/AZone")).toBeNull();
  });

  it("still works for a real timezone", () => {
    expect(localHour(new Date("2026-09-08T17:00:00Z"), "America/New_York")).toBe(13);
  });

  /**
   * A window that starts after it ends can never be open, so a stored 22-to-3
   * silently stopped a workspace sending anything and said nothing about why.
   */
  it("falls back to the federal window when the stored one is inverted", () => {
    expect(clampToFederal({ startHour: 22, endHour: 3 })).toEqual({ ...FEDERAL_BOUND });
  });

  it("falls back when clamping would collapse the window", () => {
    // 23-to-24 clamps to 23-to-21, which is inverted, so the fallback applies.
    expect(clampToFederal({ startHour: 23, endHour: 24 })).toEqual({ ...FEDERAL_BOUND });
  });

  it("narrows a window that is wider than the law allows", () => {
    expect(clampToFederal({ startHour: 0, endHour: 24 })).toEqual({ ...FEDERAL_BOUND });
  });

  it("leaves a legal window alone", () => {
    expect(clampToFederal({ startHour: 9, endHour: 20 })).toEqual({ startHour: 9, endHour: 20 });
  });

  it("never returns a window outside the federal bound", () => {
    for (const startHour of [0, 5, 8, 12, 20, 23]) {
      for (const endHour of [0, 3, 9, 21, 24]) {
        const c = clampToFederal({ startHour, endHour });
        expect(c.startHour, `${startHour}-${endHour}`).toBeGreaterThanOrEqual(FEDERAL_BOUND.startHour);
        expect(c.endHour, `${startHour}-${endHour}`).toBeLessThanOrEqual(FEDERAL_BOUND.endHour);
        expect(c.startHour, `${startHour}-${endHour}`).toBeLessThan(c.endHour);
      }
    }
  });
});
