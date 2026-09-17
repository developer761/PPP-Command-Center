import { describe, it, expect } from "vitest";

import { AR_PERIODS, arPeriodCutoff, AR_APPLICATIONS_SPEC } from "@/lib/commercial/reports/tomco/ar-applications";
import { AR_CARRYOVER } from "@/lib/commercial/reports/tomco/ar-carryover";

/**
 * A date filter on the AR sheet must not empty the AR sheet.
 *
 * Karan 2026-09-17: "AR sheet filters such as 30 days, 90 days etc."
 *
 * The obvious implementation — `rows.filter(r => r.issuedYmd >= cutoff)` —
 * would have shown $0. Every one of Mary's carried-over lines has
 * `issuedYmd: null`: they are her own rows, typed by hand, with no certificate
 * behind them to carry a date. They are also, today, the ENTIRE sheet, worth
 * $314,048.14, because the generated rows only appear once she raises her first
 * application in the platform.
 *
 * So the rule is: the period narrows the DATED rows, and undated rows are
 * always kept and always counted. This pins that, and pins "all time" as the
 * default — a receivables sheet is a chase list, and the oldest line on it is
 * the one somebody opened the page to find.
 */

// The filter exactly as app/commercial/accounting/page.tsx applies it.
const applyPeriod = <T extends { issuedYmd: string | null }>(rows: T[], key: string): T[] => {
  const cutoff = arPeriodCutoff(key);
  return cutoff ? rows.filter((r) => !r.issuedYmd || r.issuedYmd >= cutoff) : rows;
};

describe("the AR sheet's period filter", () => {
  it("defaults to all time", () => {
    expect(AR_PERIODS[0].key).toBe("all");
    expect(AR_PERIODS[0].days).toBeNull();
    expect(arPeriodCutoff("all")).toBeNull();
  });

  it("offers the 30 and 90 day windows that were asked for", () => {
    expect(AR_PERIODS.map((p) => p.key)).toContain("30d");
    expect(AR_PERIODS.map((p) => p.key)).toContain("90d");
  });

  it("KEEPS Mary's undated lines in every period", () => {
    // THE REGRESSION. Drop the `!r.issuedYmd ||` and this goes to zero rows.
    const rows = [
      { issuedYmd: null, openCents: 17_773_393 }, // the $177,733.93 LMJ-AIREF line
      { issuedYmd: null, openCents: 5_000_00 },
      { issuedYmd: "2020-01-01", openCents: 1_000_00 }, // genuinely old, should go
    ];
    for (const key of ["30d", "90d", "12m"]) {
      const kept = applyPeriod(rows, key);
      expect(kept.filter((r) => r.issuedYmd === null)).toHaveLength(2);
      expect(kept.find((r) => r.issuedYmd === "2020-01-01")).toBeUndefined();
    }
  });

  it("would have emptied the real sheet — which is why the rule exists", () => {
    // Not hypothetical: the carryover baseline IS the sheet right now, and
    // every row in it is undated by construction.
    expect(AR_CARRYOVER.length).toBeGreaterThan(0);
    const asRows = AR_CARRYOVER.map(() => ({ issuedYmd: null as string | null }));
    expect(applyPeriod(asRows, "30d")).toHaveLength(AR_CARRYOVER.length);
    // The naive version, for contrast — this is what was NOT shipped.
    const naive = asRows.filter((r) => r.issuedYmd && r.issuedYmd >= (arPeriodCutoff("30d") ?? ""));
    expect(naive).toHaveLength(0);
  });

  it("keeps a recently issued certificate", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expect(applyPeriod([{ issuedYmd: today }], "30d")).toHaveLength(1);
  });

  it("still offers a by-GC view, which is what 'views by account' needs", () => {
    const keys = AR_APPLICATIONS_SPEC.groupings.map((g) => g[0]?.key);
    expect(keys).toContain("gc");
    expect(keys).toContain("job");
    // The page indexes into this array from the URL, so an empty or reordered
    // set would silently change which view a saved link opens.
    expect(AR_APPLICATIONS_SPEC.groupings.length).toBeGreaterThanOrEqual(4);
  });
});
