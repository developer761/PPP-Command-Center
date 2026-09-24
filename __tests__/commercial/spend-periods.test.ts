import { describe, it, expect } from "vitest";
import {
  spendPeriodRange,
  filterToSpendPeriod,
  isSpendPeriod,
  undatedCount,
  spendPeriodLabel,
} from "@/lib/commercial/reports/tomco/spend-periods";

/**
 * The window on Mary's payout register. She reconciles it against Salesforce a
 * week at a time, so the boundaries have to be the ones Salesforce uses —
 * Monday to Sunday — and inclusive at both ends, or a payment on the Monday or
 * the Sunday goes missing from exactly one side of the comparison.
 *
 * Every date here is pinned, so these do not start failing in a future week.
 */
describe("the spend register's date window", () => {
  // Thursday 2026-09-24. Its Monday is 2026-09-21.
  const THU = "2026-09-24";

  it("runs this week from Monday to TODAY, not to Sunday", () => {
    // Deliberately partial: she is asking what has gone out so far. Padding to
    // Sunday shows an empty back half and reads as missing rows.
    expect(spendPeriodRange("this_week", THU)).toEqual({ from: "2026-09-21", to: THU });
  });

  it("runs last week as a whole Monday-to-Sunday block", () => {
    expect(spendPeriodRange("last_week", THU)).toEqual({ from: "2026-09-14", to: "2026-09-20" });
  });

  it("treats Sunday as the END of its week, not the start", () => {
    // Sunday 2026-09-27 belongs to the week beginning Monday the 21st. Getting
    // this wrong shifts every week by a day and silently moves payments.
    expect(spendPeriodRange("this_week", "2026-09-27")).toEqual({
      from: "2026-09-21",
      to: "2026-09-27",
    });
    expect(spendPeriodRange("last_week", "2026-09-27")).toEqual({
      from: "2026-09-14",
      to: "2026-09-20",
    });
  });

  it("handles a week that spans a month boundary", () => {
    // Thursday 2026-10-01 — its Monday is in September.
    expect(spendPeriodRange("this_week", "2026-10-01")).toEqual({
      from: "2026-09-28",
      to: "2026-10-01",
    });
  });

  it("handles last month across a year boundary", () => {
    expect(spendPeriodRange("last_month", "2027-01-15")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("gets the last day of a short month right", () => {
    expect(spendPeriodRange("last_month", "2026-03-10")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    // 2028 is a leap year.
    expect(spendPeriodRange("last_month", "2028-03-10")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("is inclusive at BOTH ends", () => {
    const rows = [
      { ymd: "2026-09-13" }, // Sunday before — out
      { ymd: "2026-09-14" }, // Monday — in
      { ymd: "2026-09-17" }, // midweek — in
      { ymd: "2026-09-20" }, // Sunday — in
      { ymd: "2026-09-21" }, // next Monday — out
    ];
    expect(filterToSpendPeriod(rows, "last_week", THU).map((r) => r.ymd)).toEqual([
      "2026-09-14",
      "2026-09-17",
      "2026-09-20",
    ]);
  });

  it("keeps an undated row on all-time and only there, and can count them", () => {
    const rows = [{ ymd: null }, { ymd: "2026-09-17" }];
    expect(filterToSpendPeriod(rows, "all", THU)).toHaveLength(2);
    expect(filterToSpendPeriod(rows, "last_week", THU).map((r) => r.ymd)).toEqual(["2026-09-17"]);
    expect(undatedCount(rows)).toBe(1);
  });

  it("returns null for all-time rather than an enormous range", () => {
    expect(spendPeriodRange("all", THU)).toBeNull();
    expect(spendPeriodLabel("all", THU)).toBe("All time");
  });

  it("names the window with its actual dates, for the CSV header", () => {
    expect(spendPeriodLabel("last_week", THU)).toBe("Last week (2026-09-14 to 2026-09-20)");
  });

  it("refuses a period it does not know rather than inventing one", () => {
    expect(isSpendPeriod("last_week")).toBe(true);
    expect(isSpendPeriod("next_week")).toBe(false);
    expect(isSpendPeriod(undefined)).toBe(false);
    expect(isSpendPeriod("")).toBe(false);
  });
});
