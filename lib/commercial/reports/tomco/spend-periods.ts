/**
 * The date window on Mary's money-out registers.
 *
 * Mary 2026-09-24: *"Can I run a payout report for this week? I want to match
 * it against SF."* — and she could not. Purchases, Labor payments and Deposits
 * each listed EVERY row ever recorded, with no way to narrow to a week, and
 * the CSV exported the same. Matching a week against Salesforce meant
 * exporting 851 rows and filtering them in Excel.
 *
 * Whole weeks run Monday–Sunday, because that is how Tomco's payroll and
 * Salesforce both cut them. "This week" therefore means the current Monday
 * through today — a partial week, deliberately: she is asking what has gone
 * out so far, and padding it to Sunday would show a window with no data in
 * the back half and make the register look like it was missing rows.
 */

export type SpendPeriodKey =
  | "all"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month";

export const SPEND_PERIODS: { key: SpendPeriodKey; label: string }[] = [
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "all", label: "All time" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return iso(dt);
}

/** Monday of the week containing `ymd`. */
function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

/** Today in America/New_York. Tomco is on Long Island; UTC would roll the
 *  window over at 8pm and move a payment into "tomorrow". */
export function todayEt(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function isSpendPeriod(v: string | null | undefined): v is SpendPeriodKey {
  return SPEND_PERIODS.some((p) => p.key === v);
}

/** The window, or null for "all time". `to` is inclusive. */
export function spendPeriodRange(
  key: SpendPeriodKey,
  today = todayEt(),
): { from: string; to: string } | null {
  if (key === "all") return null;
  const thisMonday = mondayOf(today);
  switch (key) {
    case "this_week":
      return { from: thisMonday, to: today };
    case "last_week": {
      const from = addDays(thisMonday, -7);
      return { from, to: addDays(from, 6) };
    }
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const [y, m] = today.split("-").map(Number);
      const prevY = m === 1 ? y - 1 : y;
      const prevM = m === 1 ? 12 : m - 1;
      const first = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
      // Day 0 of the following month is the last day of this one.
      const last = iso(new Date(Date.UTC(prevY, prevM, 0)));
      return { from: first, to: last };
    }
  }
}

export function spendPeriodLabel(key: SpendPeriodKey, today = todayEt()): string {
  const name = SPEND_PERIODS.find((p) => p.key === key)?.label ?? "All time";
  const r = spendPeriodRange(key, today);
  return r ? `${name} (${r.from} to ${r.to})` : name;
}

/**
 * Filter any dated row to the window.
 *
 * A row with NO date is kept only on "all time". It cannot be shown to fall
 * inside a week, and quietly dropping it from every window would make the
 * totals disagree with the unfiltered register with nothing saying why.
 */
export function filterToSpendPeriod<T extends { ymd: string | null }>(
  rows: T[],
  key: SpendPeriodKey,
  today = todayEt(),
): T[] {
  const r = spendPeriodRange(key, today);
  if (!r) return rows;
  return rows.filter((row) => row.ymd != null && row.ymd >= r.from && row.ymd <= r.to);
}

/** Rows with no date at all — surfaced rather than silently dropped. */
export function undatedCount<T extends { ymd: string | null }>(rows: T[]): number {
  return rows.filter((r) => r.ymd == null).length;
}
