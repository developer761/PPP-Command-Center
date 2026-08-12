import { describe, it, expect } from "vitest";
import { etDateOf } from "@/lib/date-et";
describe("etDateOf", () => {
  it("leaves a bare DATE alone — it has no zone to convert", () => {
    // `new Date("2026-08-12")` is UTC midnight; converting to Eastern moved it
    // to the 11th, so a proposal due TODAY read "1 day overdue".
    expect(etDateOf("2026-08-12")).toBe("2026-08-12");
    expect(etDateOf("2026-01-01")).toBe("2026-01-01");
  });
  it("still converts a real timestamp to the Eastern calendar day", () => {
    // 01:00 UTC on the 1st is still the previous evening in New York.
    expect(etDateOf("2026-09-01T01:00:00Z")).toBe("2026-08-31");
    expect(etDateOf("2026-09-01T16:00:00Z")).toBe("2026-09-01");
  });
  it("returns null for nothing and for nonsense", () => {
    expect(etDateOf(null)).toBeNull();
    expect(etDateOf("")).toBeNull();
    expect(etDateOf("not a date")).toBeNull();
  });
});
