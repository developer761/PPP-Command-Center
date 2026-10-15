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

// ─────────────────────────── Labor ───────────────────────────

export type LaborPreset = "this_week" | "last_week" | "this_month" | "last_month" | "last_90" | "this_year";

export const LABOR_PRESETS: { key: LaborPreset; label: string }[] = [
  // Payroll runs weekly, so the week is a first-class window here — it was the
  // one period a payroll clerk actually needs and the only one missing.
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
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
    case "this_week":
      // Monday–today, not Monday–Sunday: a week in progress shouldn't claim
      // hours that haven't been worked yet.
      return { fromYmd: weekStartOf(today), toYmd: today, label: "This week" };
    case "last_week": {
      const thisMon = weekStartOf(today);
      const d = new Date(`${thisMon}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7);
      const from = d.toISOString().slice(0, 10);
      d.setUTCDate(d.getUTCDate() + 6);
      return { fromYmd: from, toYmd: d.toISOString().slice(0, 10), label: "Last week" };
    }
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

// ─────────────────────── E-signatures ───────────────────────

export type SignaturePreset = "last_30" | "last_90" | "this_year" | "all";

export const SIGNATURE_PRESETS: { key: SignaturePreset; label: string }[] = [
  { key: "last_30", label: "Last 30 days" },
  { key: "last_90", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "all", label: "All time" },
];

export const SIGNATURE_DEFAULT: SignaturePreset = "last_90";

/** Window on when the signing link was SENT — a signature belongs to the
 *  request it answers, so a link sent in August and signed in September counts
 *  once, in August. */
export function signatureRange(preset: SignaturePreset): RangeResult {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  switch (preset) {
    case "last_30":
      return { fromYmd: daysBack(29), toYmd: today, label: "last 30 days" };
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: `${y}` };
    case "all":
      return { fromYmd: "2000-01-01", toYmd: today, label: "all time" };
    case "last_90":
    default:
      return { fromYmd: daysBack(89), toYmd: today, label: "last 90 days" };
  }
}

// ───────────────── Activity period (day / week / month / year) ─────────────────
//
// Karan, 2026-08-19: *"can we have filters like by day, week, monthly, year"*.
//
// Used where the question is "what happened IN a period" — as opposed to the
// report-level presets above, which pick a reporting window.
//
// `all` is a first-class option and, on a chase list, the DEFAULT. Filtering
// receivables to "this month" would hide every old debt, which is the exact
// opposite of what an ageing book is for: the oldest item is the one that most
// needs looking at. A period filter there is for narrowing on purpose, never
// the state you land in.

export type ActivityPreset =
  | "all" | "today" | "this_week" | "this_month" | "this_quarter" | "this_year" | "last_year";

export const ACTIVITY_PRESETS: { key: ActivityPreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
];

export const ACTIVITY_DEFAULT: ActivityPreset = "all";

/**
 * The TRANSACTIONS ledger opens on this month, not all time.
 *
 * Its own default, deliberately separate from ACTIVITY_DEFAULT: the
 * receivables chase list must keep defaulting to the whole book, because
 * hiding old debt is the one thing a collections screen must never do, and
 * there is a test saying so.
 *
 * The ledger has the opposite problem. On "all time" it renders 10,908kb of
 * HTML — ten and a half megabytes, growing weekly — against 1,347kb for a
 * month. Nothing is hidden: the period control is right there, it names the
 * window, and All time is one click away.
 */
export const LEDGER_DEFAULT: ActivityPreset = "this_month";

/** Monday of the ET week containing a YYYY-MM-DD. Matches the payroll week
 *  already used by the labor report — two different "weeks" in one platform
 *  would make a Sunday shift land in different weeks on different screens. */
export function weekStartOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 = Sunday, so shift Sunday back 6 days, not forward 1.
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** Null for `all` — an unbounded window, which callers must treat as "no
 *  filter" rather than inventing a sentinel date that silently clips history. */
export function activityRange(preset: ActivityPreset): RangeResult | null {
  const today = etTodayIso();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  switch (preset) {
    case "today":
      return { fromYmd: today, toYmd: today, label: "Today" };
    case "this_week": {
      const start = weekStartOf(today);
      return { fromYmd: start, toYmd: today, label: "This week" };
    }
    case "this_month":
      return { fromYmd: `${y}-${pad(m)}-01`, toYmd: today, label: "This month" };
    case "this_quarter": {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      return { fromYmd: `${y}-${pad(qStart)}-01`, toYmd: today, label: "This quarter" };
    }
    case "this_year":
      return { fromYmd: `${y}-01-01`, toYmd: today, label: "This year" };
    case "last_year":
      return { fromYmd: `${y - 1}-01-01`, toYmd: `${y - 1}-12-31`, label: `${y - 1}` };
    case "all":
    default:
      return null;
  }
}

// ─────────────────────────── Dashboard ───────────────────────────
//
// Katie 2026-10-15, for Alex: the Commercial home screen gets ONE period
// picker, defaulting to this fiscal year. Quarters and years are FISCAL —
// PPP's year starts in February (FY26 = 2026-02-01 → 2027-01-31, Q1 = Feb–Apr)
// — read from `fiscal_year_start_month`, so a licensee on a calendar year gets
// calendar quarters with no code change.
//
// Only the ACTIVITY figures follow the range (revenue billed, job costs, net,
// margin, wins). Balances — what is owed, the pipeline, what is under
// contract — are "as of today" whatever the picker says. See
// `lib/commercial/dashboard/metric-notes.ts`, which tells the reader the same.

export type DashboardPreset =
  | "this_month" | "last_month" | "this_quarter" | "last_quarter"
  | "this_fy" | "last_fy" | "all" | "custom";

export const DASHBOARD_PRESETS: { key: DashboardPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "this_fy", label: "This FY" },
  { key: "last_fy", label: "Last FY" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

export const DASHBOARD_DEFAULT: DashboardPreset = "this_fy";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD, or null. "2026-02-31" is not one. */
export function validYmd(raw: string | null | undefined): string | null {
  if (!raw || !YMD_RE.test(raw)) return null;
  const d = new Date(`${raw}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw ? raw : null;
}

/** First day of the month `n` months after (y, m), as YYYY-MM-DD. m is 1-based. */
function monthStartPlus(y: number, m: number, n: number): string {
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
}

/** The day before a YYYY-MM-DD. */
function dayBefore(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (b − a). */
function daysBetweenYmd(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a dashboard preset to an inclusive ET date window.
 *
 * Null for `all` (no filter — callers must not invent a sentinel start date
 * that silently clips history), and for a `custom` range whose dates are
 * missing or invalid, which falls back to the default rather than guessing.
 *
 * `today` is a parameter so the fiscal arithmetic is testable on any date; the
 * page passes `etTodayIso()`.
 */
export function dashboardRange(
  preset: DashboardPreset,
  fyStartMonth: number,
  today: string = etTodayIso(),
  custom?: { from?: string | null; to?: string | null }
): RangeResult | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fyStart = Math.min(12, Math.max(1, Math.round(fyStartMonth || 1)));
  const fiscal = fyStart !== 1;
  // FY named by its START year (FY26 = Feb 2026 → Jan 2027).
  const fyYear = m >= fyStart ? y : y - 1;
  const fyLabel = (yy: number) => (fiscal ? `FY${String(yy).slice(-2)}` : `${yy}`);
  // Months since the fiscal year began (0-based), and the quarter that puts us in.
  const monthsIntoFy = (m - fyStart + 12) % 12;
  const qIndex = Math.floor(monthsIntoFy / 3); // 0..3
  const qStart = monthStartPlus(fyYear, fyStart, qIndex * 3);
  const qLabel = (fy: number, q: number) => `Q${q + 1} ${fyLabel(fy)}`;

  switch (preset) {
    case "this_month":
      return { fromYmd: `${y}-${pad(m)}-01`, toYmd: today, label: "This month" };
    case "last_month": {
      const from = monthStartPlus(y, m, -1);
      return { fromYmd: from, toYmd: dayBefore(`${y}-${pad(m)}-01`), label: "Last month" };
    }
    case "this_quarter":
      return { fromYmd: qStart, toYmd: today, label: qLabel(fyYear, qIndex) };
    case "last_quarter": {
      const prevFy = qIndex === 0 ? fyYear - 1 : fyYear;
      const prevQ = qIndex === 0 ? 3 : qIndex - 1;
      const from = monthStartPlus(prevFy, fyStart, prevQ * 3);
      return { fromYmd: from, toYmd: dayBefore(qStart), label: qLabel(prevFy, prevQ) };
    }
    case "this_fy":
      return { fromYmd: monthStartPlus(fyYear, fyStart, 0), toYmd: today, label: `${fyLabel(fyYear)} to date` };
    case "last_fy":
      return {
        fromYmd: monthStartPlus(fyYear - 1, fyStart, 0),
        toYmd: dayBefore(monthStartPlus(fyYear, fyStart, 0)),
        label: fyLabel(fyYear - 1),
      };
    case "custom": {
      const from = validYmd(custom?.from ?? null);
      const to = validYmd(custom?.to ?? null);
      if (!from || !to) return dashboardRange(DASHBOARD_DEFAULT, fyStartMonth, today);
      // Accept either order — a reversed pair is a slip, not a request for nothing.
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { fromYmd: a, toYmd: b, label: `${a} → ${b}` };
    }
    case "all":
    default:
      return null;
  }
}

/**
 * The window a delta compares against — "vs last", like for like.
 *
 * An IN-PROGRESS period (this month / quarter / FY) is compared with the SAME
 * number of elapsed days at the start of the period before it, so the 2nd of
 * the month is not measured against the whole of last month. A COMPLETED period
 * is compared with the whole period before it. All time and custom ranges have
 * no natural "last", so they get none rather than an invented one.
 */
export function priorDashboardRange(
  preset: DashboardPreset,
  fyStartMonth: number,
  today: string = etTodayIso()
): RangeResult | null {
  const cur = dashboardRange(preset, fyStartMonth, today);
  if (!cur || preset === "all" || preset === "custom") return null;
  const prevOf: Partial<Record<DashboardPreset, DashboardPreset>> = {
    this_month: "last_month",
    this_quarter: "last_quarter",
    this_fy: "last_fy",
  };
  const prevPreset = prevOf[preset];
  if (prevPreset) {
    const prev = dashboardRange(prevPreset, fyStartMonth, today)!;
    const elapsed = daysBetweenYmd(cur.fromYmd, cur.toYmd);
    const cutoff = addDays(prev.fromYmd, elapsed);
    return { fromYmd: prev.fromYmd, toYmd: cutoff < prev.toYmd ? cutoff : prev.toYmd, label: `same point ${prev.label.toLowerCase()}` };
  }
  // Completed periods: the period immediately before, in the same unit —
  // "last month" as seen from the first day of the period being shown.
  if (preset === "last_month" || preset === "last_quarter" || preset === "last_fy") {
    return dashboardRange(preset, fyStartMonth, cur.fromYmd);
  }
  return null;
}
