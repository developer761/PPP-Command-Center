import { describe, it, expect } from "vitest";
import { anchorDateOnlyIso } from "@/lib/commercial/dates";

/**
 * anchorDateOnlyIso pins a bare <input type="date"> value at noon ET so it
 * renders on the day the user actually picked (UTC-midnight would show the day
 * before). Phase 0 dedup standardized every write-side anchor on this (was a
 * mix of T16 and T12). These tests pin the contract.
 */
describe("anchorDateOnlyIso", () => {
  it("anchors a valid YYYY-MM-DD at 16:00 UTC (noon-ish ET, same calendar day)", () => {
    expect(anchorDateOnlyIso("2026-08-16")).toBe("2026-08-16T16:00:00.000Z");
  });

  it("renders on the intended ET calendar day (not the day before)", () => {
    const iso = anchorDateOnlyIso("2026-08-16")!;
    const etDay = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expect(etDay).toBe("2026-08-16");
  });

  it("holds across the EST/EDT boundary (winter date stays same ET day)", () => {
    const iso = anchorDateOnlyIso("2026-01-15")!;
    const etDay = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expect(etDay).toBe("2026-01-15");
  });

  it("returns null for anything that isn't a bare date (caller picks its fallback)", () => {
    expect(anchorDateOnlyIso("")).toBeNull();
    expect(anchorDateOnlyIso("not-a-date")).toBeNull();
    expect(anchorDateOnlyIso("2026-08-16T09:30:00Z")).toBeNull(); // already a full timestamp
    expect(anchorDateOnlyIso("2026-8-6")).toBeNull(); // unpadded — not the input-date shape
  });
});
