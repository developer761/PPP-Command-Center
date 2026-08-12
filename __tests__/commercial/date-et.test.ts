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

/**
 * AUDIT 2026-08-12 (parallel review session): fixing `etDateOf` fixed the
 * ROOT, but three callers did their own UTC subtraction and kept the bug.
 * `fmtEtDate` is the one that printed it — every invoice, statement and AR
 * row renders through it, and a bare DATE came out a day early.
 */
describe("fmtEtDate — the printed day matches the stored one", () => {
  it("prints a bare DATE as itself, not the day before", async () => {
    const { fmtEtDate } = await import("@/lib/commercial/invoices/format");
    expect(fmtEtDate("2026-08-12")).toBe("Aug 12, 2026");
    // The nastiest case: the 1st of a month rolled back into the prior month.
    expect(fmtEtDate("2026-08-01")).toBe("Aug 1, 2026");
    expect(fmtEtDate("2026-01-01")).toBe("Jan 1, 2026");
  });

  it("still zone-shifts a real timestamp to Eastern", async () => {
    const { fmtEtDate } = await import("@/lib/commercial/invoices/format");
    expect(fmtEtDate("2026-09-01T01:00:00Z")).toBe("Aug 31, 2026");
    expect(fmtEtDate("2026-09-01T16:00:00Z")).toBe("Sep 1, 2026");
  });

  it("renders nothing as an em dash rather than 'Invalid Date'", async () => {
    const { fmtEtDate } = await import("@/lib/commercial/invoices/format");
    expect(fmtEtDate(null)).toBe("—");
    expect(fmtEtDate("not a date")).toBe("—");
  });
});
