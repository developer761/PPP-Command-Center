import { describe, it, expect } from "vitest";
import { parseTypedDate } from "@/components/commercial/date-field";

/** Brendan 2026-08-17: bid sets are usually a year+ old, so the calendar-only
 *  field meant paging back 12+ months every time. Typing is now the fast path. */
describe("parseTypedDate", () => {
  it("accepts the US shapes people actually type", () => {
    expect(parseTypedDate("8/5/2025")).toBe("2025-08-05");
    expect(parseTypedDate("08/05/2025")).toBe("2025-08-05");
    expect(parseTypedDate("8-5-2025")).toBe("2025-08-05");
    expect(parseTypedDate("8.5.2025")).toBe("2025-08-05");
  });

  it("expands a 2-digit year on the 70 pivot", () => {
    expect(parseTypedDate("8/5/25")).toBe("2025-08-05");
    expect(parseTypedDate("8/5/99")).toBe("1999-08-05");
  });

  it("accepts ISO and written month names", () => {
    expect(parseTypedDate("2025-08-05")).toBe("2025-08-05");
    expect(parseTypedDate("Aug 5, 2025")).toBe("2025-08-05");
    expect(parseTypedDate("August 5 2025")).toBe("2025-08-05");
    expect(parseTypedDate("5 Aug 2025")).toBe("2025-08-05");
  });

  it("rejects impossible dates rather than rolling them over", () => {
    // new Date(2025,1,30) would silently become Mar 2 — never do that to a bid date.
    expect(parseTypedDate("2/30/2025")).toBeNull();
    expect(parseTypedDate("13/1/2025")).toBeNull();
    expect(parseTypedDate("2/29/2025")).toBeNull(); // 2025 is not a leap year
    expect(parseTypedDate("2/29/2024")).toBe("2024-02-29"); // 2024 is
  });

  it("returns null for junk so the field can revert instead of trapping the user", () => {
    expect(parseTypedDate("")).toBeNull();
    expect(parseTypedDate("next tuesday")).toBeNull();
    expect(parseTypedDate("4,28O")).toBeNull();
  });
});
