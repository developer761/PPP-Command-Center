/**
 * America/New_York calendar-date helpers. PPP/Tomco operate in ET, so anything
 * that stamps, defaults, compares, or counts a CALENDAR DATE must use the ET
 * day, not the server's UTC day. Plain module (no "server-only") so both server
 * components and client code can use it.
 *
 * The recurring bug this fixes: `new Date().toISOString().slice(0,10)` and
 * `new Date('2026-08-04')` (parsed as UTC midnight) both shift a day backward
 * during ET evening hours; and comparing a bare DATE string ("2026-08-04") to a
 * full ISO datetime ("2026-08-04T00:00:00.000Z") is lexicographically wrong.
 */

/** Today's ET calendar date as YYYY-MM-DD. */
export function etTodayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * The ET calendar date a timestamp fell on, as YYYY-MM-DD.
 *
 * For stamping a decision date from WHEN SOMETHING HAPPENED rather than from
 * now — an automatic move made months later must not record today as the day
 * the deal was won, or the win lands in the wrong month's numbers.
 * Returns null for anything unparseable, so callers fall back deliberately.
 */
export function etDateOf(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  // AUDIT 2026-08-12: a bare DATE has no time and no zone, and `new Date`
  // parses "2026-08-12" as UTC MIDNIGHT — so converting it to Eastern moved it
  // to the 11th. Every DATE column on the platform runs through here:
  // proposal_due_at, follow_up_at, the work-order and field-ops dates. A
  // proposal due TODAY read "1 day overdue", and every one of those figures was
  // a day early.
  //
  // A date-only string is already the calendar day somebody typed. There is
  // nothing to convert, so it is returned untouched. Only real timestamps get
  // zone-shifted.
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) return timestamp;
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Whole days from ET-today to a plain YYYY-MM-DD (future = positive, past = negative). */
export function daysFromTodayEt(dateIso: string): number {
  const d = (dateIso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const [ty, tm, td] = etTodayIso().split("-").map(Number);
  const [y, m, dd] = d.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/** True if a plain YYYY-MM-DD date is strictly before ET-today (i.e. past due). */
export function isPastEt(dateIso: string): boolean {
  return daysFromTodayEt(dateIso) < 0;
}

/**
 * Whole ET calendar days between a timestamp and today. Never negative.
 *
 * The "3d ago" number, and the one every idle/stale threshold compares.
 *
 * AUDIT 2026-08-12: this existed FOUR times as a private copy
 * (`relativeAgo`, `daysSinceIso`, and two inline versions), each flooring a
 * raw UTC subtraction. A DST week is 23 or 25 hours, so the floor lands a day
 * early at the boundary — which is small on a label and not small on a
 * threshold, where "idle 14 days" is a colour change and "overdue N days" goes
 * into an email somebody reads.
 *
 * Counting calendar dates instead of dividing elapsed milliseconds removes the
 * whole question: two dates either are the same day in New York or they are
 * not, whatever the clocks did in between.
 *
 * Returns null for a missing or unparseable timestamp, so callers can render
 * nothing rather than "NaN days ago".
 */
export function daysAgoEt(timestamp: string | null | undefined): number | null {
  const d = etDateOf(timestamp);
  if (!d) return null;
  return Math.max(0, -daysFromTodayEt(d));
}

/**
 * "today" · "yesterday" · "3d ago" · "2w ago" · "4mo ago" · "2y ago".
 *
 * Existed three times over — `relativeAgo` on the pipeline, `relativeTouch` on
 * the account page, `relativeActivity` in the accounts lib — each with the
 * same ladder and the same UTC-subtraction bug beneath it. Three copies of a
 * label is three chances for the same job to read "6d ago" on one screen and
 * "yesterday" on another.
 */
export function relativeAgoEt(timestamp: string | null | undefined, fallback = "—"): string {
  const days = daysAgoEt(timestamp);
  if (days === null) return fallback;
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
