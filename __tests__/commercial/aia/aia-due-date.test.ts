import { describe, it, expect } from "vitest";
import { aiaIssuedAtFrom, aiaDueAtFrom } from "@/lib/commercial/aia/constants";
import { daysPastDue } from "@/lib/commercial/reports/ar-aging";

/**
 * When an AIA payment application falls due.
 *
 * This ladder had been written out three separate times — the AR-aging report,
 * the receivables chase list, and the dashboard's project rows. Three copies is
 * three chances for a job to be sixty days late on one screen and perfectly
 * current on the one above it, which is exactly what happened: the dashboard
 * could add AIA money to "Owed to us" but had no date to age it by, so it
 * always read as not-overdue.
 */

const DUE_DAYS = 30;

describe("aiaIssuedAtFrom", () => {
  it("prefers frozen_at — the instant the certificate was issued", () => {
    expect(aiaIssuedAtFrom("2026-07-22T14:03:00.000Z", "2026-07-31")).toBe(
      "2026-07-22T14:03:00.000Z"
    );
  });

  it("falls back to the period end, anchored at noon ET", () => {
    // 16:00Z is noon ET. A bare DATE anchored at midnight lands on the previous
    // day for anyone east of UTC and can flip the bucket.
    expect(aiaIssuedAtFrom(null, "2026-07-31")).toBe("2026-07-31T16:00:00Z");
  });

  it("is null when nothing recorded when it went out — never today", () => {
    expect(aiaIssuedAtFrom(null, null)).toBeNull();
    expect(aiaIssuedAtFrom(undefined, undefined)).toBeNull();
  });
});

describe("aiaDueAtFrom", () => {
  it("adds the standard terms to the issue instant", () => {
    expect(aiaDueAtFrom(null, "2026-07-01", DUE_DAYS)).toBe("2026-07-31T16:00:00.000Z");
  });

  it("is null when the issue date is unknown", () => {
    expect(aiaDueAtFrom(null, null, DUE_DAYS)).toBeNull();
  });

  it("is null on an unparseable date rather than an Invalid Date string", () => {
    expect(aiaDueAtFrom("not-a-date", null, DUE_DAYS)).toBeNull();
  });

  it("agrees with daysPastDue about what is late", () => {
    const due = aiaDueAtFrom(null, "2026-06-01", DUE_DAYS)!; // due 2026-07-01
    const aug19 = Date.parse("2026-08-19T18:00:00Z");
    expect(daysPastDue(due, aug19)).toBe(49);
    // …and the day it comes due is not yet late.
    expect(daysPastDue(due, Date.parse("2026-07-01T18:00:00Z"))).toBe(0);
  });
});
