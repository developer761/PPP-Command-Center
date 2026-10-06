import { describe, it, expect } from "vitest";
import { holidayIn, isHolidayIn } from "@/lib/messaging/holidays";

/**
 * `send_on_holidays` has been a column since migration 179 — "Holidays default
 * OFF: a painting estimate chase on Thanksgiving morning reads badly even
 * where it is legal" — false on all 33 workspaces, with no calendar and no
 * check anywhere. The data said one thing and the gate would have sent on
 * Christmas morning.
 *
 * It is also Kate's condition on the event-park cadence, 2026-10-05: "as long
 * as we have a mechanism that keeps customers from being messaged on specific
 * holidays and the msg would send the following open day."
 *
 * The floating dates are the part worth testing hard. "Fourth Thursday in
 * November" is easy to write and easy to get wrong by a week, and a calendar
 * that is wrong once a year is wrong in exactly the way nobody notices until
 * the day.
 */
const ET = "America/New_York";
/** Noon local, so no test is accidentally about a timezone edge. */
const noon = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 16, 0));

describe("the fixed dates", () => {
  it.each([
    [2026, 1, 1, "New Year's Day"],
    [2026, 7, 4, "Independence Day"],
    [2026, 12, 24, "Christmas Eve"],
    [2026, 12, 25, "Christmas Day"],
    [2030, 1, 1, "New Year's Day"],
    [2030, 12, 25, "Christmas Day"],
  ])("%i-%i-%i is %s", (y, m, d, name) => {
    expect(holidayIn(noon(y, m, d), ET)).toBe(name);
  });
});

/**
 * Checked against the real calendar, year by year, because an off-by-one week
 * here is invisible until the morning it matters.
 */
describe("the floating ones", () => {
  it.each([
    [2026, 5, 25], [2027, 5, 31], [2028, 5, 29], [2029, 5, 28],
  ])("Memorial Day %i is May %i", (y, _m, d) => {
    expect(holidayIn(noon(y, 5, d), ET)).toBe("Memorial Day");
  });

  it.each([
    [2026, 9, 7], [2027, 9, 6], [2028, 9, 4], [2029, 9, 3],
  ])("Labor Day %i is September %i", (y, _m, d) => {
    expect(holidayIn(noon(y, 9, d), ET)).toBe("Labor Day");
  });

  it.each([
    [2026, 11, 26], [2027, 11, 25], [2028, 11, 23], [2029, 11, 22],
  ])("Thanksgiving %i is November %i", (y, _m, d) => {
    expect(holidayIn(noon(y, 11, d), ET)).toBe("Thanksgiving");
  });

  it("covers the Friday after Thanksgiving", () => {
    expect(holidayIn(noon(2026, 11, 27), ET)).toBe("the day after Thanksgiving");
  });

  /** The week either side, which is where an off-by-seven would show. */
  it.each([[2026, 11, 19], [2026, 11, 20], [2026, 11, 28], [2026, 5, 18], [2026, 9, 14]])(
    "%i-%i-%i is an ordinary day", (y, m, d) => {
      expect(holidayIn(noon(y, m, d), ET)).toBeNull();
    }
  );
});

describe("ordinary working days stay working days", () => {
  /**
   * Deliberately NOT holidays. A contractor works Presidents' Day and
   * Columbus Day, and going quiet on them would cost leads for nothing.
   */
  it.each([
    [2026, 2, 16, "Presidents' Day"],
    [2026, 10, 12, "Columbus Day"],
    [2026, 1, 19, "MLK Day"],
    [2026, 11, 11, "Veterans Day"],
    [2026, 6, 19, "Juneteenth"],
  ])("%i-%i-%i (%s) is not one", (y, m, d) => {
    expect(isHolidayIn(noon(y, m, d), ET)).toBe(false);
  });

  it("an ordinary Tuesday is not one", () => {
    expect(isHolidayIn(noon(2026, 3, 17), ET)).toBe(false);
  });
});

/**
 * WHOSE DAY IT IS. The customer's, which is the whole point — their phone is
 * the one buzzing. At 10pm Eastern on Christmas Eve it is already Christmas in
 * London and still the 24th in Los Angeles, and both answers are correct for
 * the person holding the phone.
 */
describe("the date is read in the customer's zone", () => {
  const tenPmEtOnChristmasEve = new Date(Date.UTC(2026, 11, 25, 3, 0));

  it("is Christmas Eve in New York", () => {
    expect(holidayIn(tenPmEtOnChristmasEve, "America/New_York")).toBe("Christmas Eve");
  });

  it("is still Christmas Eve in Los Angeles, three hours earlier", () => {
    expect(holidayIn(tenPmEtOnChristmasEve, "America/Los_Angeles")).toBe("Christmas Eve");
  });

  /**
   * 05:00 UTC on 5 July: 1am in New York, so the 4th is over there, and 10pm
   * in Los Angeles, where it is still Independence Day. The first fixture I
   * wrote used 02:00 UTC, which is 10pm ET on the 4th — the same day in both
   * zones, so it proved nothing. The code was right; the arithmetic was mine.
   */
  it("has rolled over for an Eastern customer when Pacific has not", () => {
    const t = new Date(Date.UTC(2026, 7 - 1, 5, 5, 0));
    expect(holidayIn(t, "America/New_York")).toBeNull();
    expect(holidayIn(t, "America/Los_Angeles")).toBe("Independence Day");
  });
});

describe("a zone it cannot read is not a holiday", () => {
  /**
   * Null rather than true. The gate has its own refusal for a workspace with
   * no timezone; answering "holiday" here would hide that with a reason that
   * is not the real one.
   */
  it.each(["", "Not/AZone", "garbage"])("%j yields null", (tz) => {
    expect(holidayIn(noon(2026, 12, 25), tz)).toBeNull();
  });
});
