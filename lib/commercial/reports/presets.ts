import { etTodayIso } from "@/lib/date-et";

/**
 * Date-range presets for the Reports suite — ONE definition, shared by each
 * report page and its export route.
 *
 * These lived as a private `rangeFor` inside each page. That was fine while
 * nothing else needed them; the moment an export route existed it became a
 * correctness problem, because a second copy of "last 90 days" is a second
 * copy that can drift. An export whose window silently differs from the screen
 * it was downloaded from is worse than no export at all — you can't see that
 * it's wrong, you just get different totals in the spreadsheet.
 *
 * So: page and route import the same function, resolve the same `?preset=`,
 * and get the same `fromYmd`/`toYmd`. Change a window here and both move.
 *
 * All maths is pure string/UTC date arithmetic anchored on `etTodayIso()`, so
 * a shift late in the evening can't land in tomorrow's bucket.
 */

export type RangeResult = { fromYmd: string; toYmd: string; label: string };

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** N days back from today, inclusive of today (so `back(89)` = 90 days). */
function daysBack(n: number): string {
  const today = etTodayIso();
  const d = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)))
  );
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** First of the month, N months back. */
function monthsBack(n: number): string {
  const today = etTodayIso();
  const total = Number(today.slice(0, 4)) * 12 + (Number(today.slice(5, 7)) - 1) - n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

function lastMonthRange(): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  return {
    fromYmd: `${ly}-${pad(lm)}-01`,
    toYmd: `${ly}-${pad(lm)}-${pad(lastDayOf(ly, lm))}`,
    label: "Last month",
  };
}

/** Resolve a raw `?preset=` value against a list, falling back to the default. */
export function resolvePreset<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly { key: T }[],
  fallback: T
): T {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return allowed.some((p) => p.key === v) ? (v as T) : fallback;
}

// ─────────────────────────── Cash flow ───────────────────────────

export type CashFlowPreset = "last_6m" | "last_12m" | "this_year" | "last_year";

export const CASH_FLOW_PRESETS: { key: CashFlowPreset; label: string }[] = [
  { key: "last_6m", label: "Last 6 months" },
  { key: "last_12m", label: "Last 12 months" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
];

export const CASH_FLOW_DEFAULT: CashFlowPreset = "last_6m";

export function cashFlowRange(preset: CashFlowPreset): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  switch (preset) {
    case "last_12m":
      return { fromYmd: monthsBack(11), toYmd: today, label: "Last 12 months" };
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "last_year":
      return { fromYmd: `${y - 1}-01-01`, toYmd: `${y - 1}-12-31`, label: `${y - 1}` };
    case "last_6m":
    default:
      return { fromYmd: monthsBack(5), toYmd: today, label: "Last 6 months" };
  }
}

// ─────────────────────────── Labour ───────────────────────────

export type LaborPreset = "this_month" | "last_month" | "last_90" | "this_year";

export const LABOR_PRESETS: { key: LaborPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
];

export const LABOR_DEFAULT: LaborPreset = "this_month";

export function laborRange(preset: LaborPreset): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  switch (preset) {
    case "last_month":
      return lastMonthRange();
    case "last_90":
      return { fromYmd: daysBack(89), toYmd: today, label: "Last 90 days" };
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "this_month":
    default:
      return { fromYmd: `${y}-${pad(m)}-01`, toYmd: today, label: "This month" };
  }
}

// ─────────────────────────── Estimator ───────────────────────────
// The only set that honours `fiscal_year_start_month`, because "this year" for
// a bid pipeline means the fiscal year the business reports on.

export type EstimatorPreset = "this_month" | "last_month" | "last_90" | "this_year" | "last_year";

export const ESTIMATOR_PRESETS: { key: EstimatorPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
];

export const ESTIMATOR_DEFAULT: EstimatorPreset = "this_year";

/** Read + clamp the configured fiscal-year start month. A bad value would
 *  silently shift every year boundary rather than erroring, so it's clamped. */
export async function fiscalYearStartMonth(): Promise<number> {
  const { getCommercialSetting } = await import("@/lib/commercial/settings");
  const raw = await getCommercialSetting<number>("fiscal_year_start_month", 1);
  return Number.isFinite(Number(raw)) ? Math.min(12, Math.max(1, Math.round(Number(raw)))) : 1;
}

export function estimatorRange(preset: EstimatorPreset, fyStartMonth: number): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fyStart = (yy: number) => `${yy}-${pad(fyStartMonth)}-01`;
  const currentFyYear = m >= fyStartMonth ? y : y - 1;
  const yearLabel = (yy: number) => (fyStartMonth === 1 ? `${yy}` : `FY${yy}`);

  switch (preset) {
    case "last_month":
      return lastMonthRange();
    case "last_90":
      return { fromYmd: daysBack(89), toYmd: today, label: "Last 90 days" };
    case "this_year":
      return { fromYmd: fyStart(currentFyYear), toYmd: today, label: yearLabel(currentFyYear) };
    case "last_year": {
      const py = currentFyYear - 1;
      const end = new Date(Date.UTC(currentFyYear, fyStartMonth - 1, 1));
      end.setUTCDate(end.getUTCDate() - 1);
      return { fromYmd: fyStart(py), toYmd: end.toISOString().slice(0, 10), label: yearLabel(py) };
    }
    case "this_month":
    default:
      return { fromYmd: `${y}-${pad(m)}-01`, toYmd: today, label: "This month" };
  }
}

// ─────────────────────── Change orders & vendors ───────────────────────

export type ChangeOrderPreset = "last_90" | "this_year" | "last_year" | "all";

export const CHANGE_ORDER_PRESETS: { key: ChangeOrderPreset; label: string }[] = [
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "all", label: "All time" },
];

export const CHANGE_ORDER_DEFAULT: ChangeOrderPreset = "this_year";

export function changeOrderRange(preset: ChangeOrderPreset): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  switch (preset) {
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "last_year":
      return { fromYmd: `${y - 1}-01-01`, toYmd: `${y - 1}-12-31`, label: `${y - 1}` };
    case "all":
      // Predates every record in the system; "all time" without an open-ended
      // query the DB would have to scan differently.
      return { fromYmd: "2000-01-01", toYmd: today, label: "all time" };
    case "last_90":
    default:
      return { fromYmd: daysBack(89), toYmd: today, label: "last 90 days" };
  }
}
