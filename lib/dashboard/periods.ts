import type { Period } from "@/lib/mock-data";

/**
 * Every period any dashboard selector can reach.
 *
 * This list exists in one place because the server now precomputes derived
 * results PER PERIOD — the dashboard views keep their period dropdowns
 * instant by reading a prebuilt map instead of re-deriving from a snapshot
 * in the browser. A period a selector can reach but the server never built
 * renders an empty card with no error, so the selectors import this rather
 * than restating it.
 */
export const ALL_PERIODS: Period[] = [
  "lifetime",
  "this-month",
  "last-month",
  "this-year",
  "last-year",
  "7d",
  "30d",
  "90d",
  "6m",
  "12m",
  "ytd",
];

/** PPP thinks month-by-month; SF reports default to similar windows. */
export const DEFAULT_PERIOD: Period = "this-month";

/**
 * Read a period off the URL the same way on the server and the client. If
 * the server derived "this-month" while the client labeled the page "Last
 * 90 days", every number on screen would be captioned with the wrong
 * window — the kind of wrong that gets believed.
 */
export function readPeriod(raw: string | string[] | undefined | null): Period {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && (ALL_PERIODS as string[]).includes(v)
    ? (v as Period)
    : DEFAULT_PERIOD;
}

/**
 * Run a per-period derive once for every period and return the map.
 *
 * The point is to keep a dropdown instant WITHOUT shipping the Salesforce
 * snapshot to the browser so the browser can re-derive. These results are
 * all bounded (top-N lists and scalar rollups), so the whole map is a few
 * tens of KB against the 35-64MB the snapshot cost.
 */
export function byPeriod<T>(derive: (p: Period) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const p of ALL_PERIODS) out[p] = derive(p);
  return out;
}
