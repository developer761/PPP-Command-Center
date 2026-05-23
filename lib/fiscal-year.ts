/**
 * PPP fiscal-year helpers.
 *
 * PPP's fiscal year runs Feb 1 → Jan 31. The FY name = the start year.
 *   FY26 = 2026-02-01 → 2027-01-31
 *
 * Fiscal quarters:
 *   Q1 Feb–Apr · Q2 May–Jul · Q3 Aug–Oct · Q4 Nov–Jan
 *
 * All KPI definitions in the shared SF reference repo (see AGENTS.md)
 * anchor on FISCAL periods, not calendar periods. % to Goal, quota progress,
 * the FPRC reports — all fiscal. The existing `periodRange()` uses
 * calendar/rolling windows; this module is the canonical fiscal layer for
 * anything that needs to match PPP's own reports.
 *
 * All functions take/return UTC dates. Use `startOfTodayInNY()` from
 * derive.ts when caller needs ET-anchored day boundaries.
 */

export type FiscalYear = number; // FY26, FY27, etc. = start year
export type FiscalQuarter = 1 | 2 | 3 | 4;

/** Returns the fiscal year (start year) the given date falls in. */
export function fiscalYearOf(date: Date): FiscalYear {
  const month = date.getUTCMonth(); // 0-indexed: 0=Jan
  const year = date.getUTCFullYear();
  // Jan = month 0 → still in the PRIOR FY (which started last Feb).
  // Feb (month 1) onward → this calendar year IS the FY name.
  return month === 0 ? year - 1 : year;
}

/** Returns the fiscal quarter (1-4) the given date falls in. */
export function fiscalQuarterOf(date: Date): FiscalQuarter {
  const month = date.getUTCMonth(); // 0-indexed
  // Feb-Apr (1-3) → Q1, May-Jul (4-6) → Q2, Aug-Oct (7-9) → Q3, Nov-Jan (10-11+0) → Q4
  if (month >= 1 && month <= 3) return 1;
  if (month >= 4 && month <= 6) return 2;
  if (month >= 7 && month <= 9) return 3;
  return 4; // Nov, Dec, Jan
}

/** Returns the current fiscal year for "right now" UTC. */
export function currentFY(): FiscalYear {
  return fiscalYearOf(new Date());
}

/** Returns the current fiscal quarter for "right now" UTC. */
export function currentFiscalQuarter(): FiscalQuarter {
  return fiscalQuarterOf(new Date());
}

/**
 * Returns the [start, end) date range covering a full fiscal year.
 *   fiscalRangeFor(2026) → { start: 2026-02-01T00:00:00Z, end: 2027-02-01T00:00:00Z }
 *
 * end is EXCLUSIVE — use `d >= start && d < end`.
 */
export function fiscalRangeFor(fy: FiscalYear): { start: Date; end: Date } {
  const start = new Date(Date.UTC(fy, 1, 1)); // Feb 1 of FY year
  const end = new Date(Date.UTC(fy + 1, 1, 1)); // Feb 1 of next year
  return { start, end };
}

/**
 * Returns the [start, end) date range covering a fiscal quarter.
 *   Q1 = Feb-Apr  → Feb 1 to May 1
 *   Q2 = May-Jul  → May 1 to Aug 1
 *   Q3 = Aug-Oct  → Aug 1 to Nov 1
 *   Q4 = Nov-Jan  → Nov 1 to Feb 1 (of fy+1)
 */
export function fiscalQuarterRange(
  fy: FiscalYear,
  q: FiscalQuarter
): { start: Date; end: Date } {
  switch (q) {
    case 1:
      return { start: new Date(Date.UTC(fy, 1, 1)), end: new Date(Date.UTC(fy, 4, 1)) };
    case 2:
      return { start: new Date(Date.UTC(fy, 4, 1)), end: new Date(Date.UTC(fy, 7, 1)) };
    case 3:
      return { start: new Date(Date.UTC(fy, 7, 1)), end: new Date(Date.UTC(fy, 10, 1)) };
    case 4:
      return { start: new Date(Date.UTC(fy, 10, 1)), end: new Date(Date.UTC(fy + 1, 1, 1)) };
  }
}

/** Convenience: range covering the current fiscal year. */
export function currentFYRange(): { start: Date; end: Date } {
  return fiscalRangeFor(currentFY());
}

/** Convenience: range covering the current fiscal quarter. */
export function currentFiscalQuarterRange(): { start: Date; end: Date } {
  return fiscalQuarterRange(currentFY(), currentFiscalQuarter());
}

/**
 * Get the prior fiscal quarter relative to a given (fy, q). Used for
 * "CloseDate in PFQ" filter patterns that PPP's FPRC reports use.
 *   prior(2026, 1) → { fy: 2025, q: 4 }
 *   prior(2026, 2) → { fy: 2026, q: 1 }
 */
export function priorFiscalQuarter(fy: FiscalYear, q: FiscalQuarter): {
  fy: FiscalYear;
  q: FiscalQuarter;
} {
  if (q === 1) return { fy: fy - 1, q: 4 };
  return { fy, q: (q - 1) as FiscalQuarter };
}

/** Human-readable label for a fiscal period: "FY26", "FY26 Q3". */
export function fyLabel(fy: FiscalYear, q?: FiscalQuarter): string {
  const yy = String(fy).slice(-2);
  return q ? `FY${yy} Q${q}` : `FY${yy}`;
}

/** Inverse of fiscalYearOf — given a fiscal year, return its label. */
export function fyName(fy: FiscalYear): string {
  return fyLabel(fy);
}

/**
 * Returns true if the given date falls in the specified fiscal year (and
 * optionally quarter). Uses UTC.
 */
export function isInFiscalPeriod(
  date: Date,
  fy: FiscalYear,
  q?: FiscalQuarter
): boolean {
  const range = q ? fiscalQuarterRange(fy, q) : fiscalRangeFor(fy);
  return date >= range.start && date < range.end;
}
