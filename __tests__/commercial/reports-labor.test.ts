import { describe, it, expect } from "vitest";

/**
 * The week bucket on the Labour report.
 *
 * Payroll weeks run Monday–Sunday. Every timezone bug on this platform started
 * by treating a DATE column as an instant, so this is deliberately pure string
 * maths — a Sunday shift must not slide into the previous week because of a
 * zone conversion, and a DST week must still contain exactly seven days.
 */
function weekStartOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const shift = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}

describe("payroll week bucketing", () => {
  it("puts every day of one Mon–Sun week in the same bucket", () => {
    // 2026-08-10 is a Monday; 2026-08-16 the Sunday after it.
    const days = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"];
    for (const d of days) expect(weekStartOf(d), d).toBe("2026-08-10");
  });

  it("starts a new bucket on Monday, not Sunday", () => {
    // The off-by-one that would split a crew's week across two payroll rows.
    expect(weekStartOf("2026-08-16")).toBe("2026-08-10"); // Sunday — still last week
    expect(weekStartOf("2026-08-17")).toBe("2026-08-17"); // Monday — new week
  });

  it("survives the DST changeovers", () => {
    // US DST 2026: forward Mar 8, back Nov 1 — both Sundays, so both belong to
    // the week that STARTED before the clock moved.
    expect(weekStartOf("2026-03-08")).toBe("2026-03-02");
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26");
  });

  it("handles a week spanning a month and a year boundary", () => {
    expect(weekStartOf("2026-09-01")).toBe("2026-08-31"); // Tue → Mon in August
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28"); // Fri → Mon in December
  });
});
