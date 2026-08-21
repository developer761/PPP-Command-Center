/**
 * Shared date helpers for the Commercial CC.
 *
 * Karan 2026-07-11 (signature-moments batch): "Today" / "Yesterday" /
 * "3d ago" / "next Tuesday" reads 10x faster than an ISO string in
 * list views. Standing rule: relative in lists, absolute in detail
 * views (with relative as a hover tooltip). This module centralizes
 * the relative-time formatter so every surface uses the same phrasing.
 *
 * Server-safe: computes against `Date.now()` at render time. There's
 * a millisecond-to-second drift between server render and client
 * hydration but the resolution is day-level so users never notice.
 */

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Anchor a bare `YYYY-MM-DD` (what `<input type="date">` posts) at noon ET so it
 * renders on the day the user actually picked. Storing it as UTC midnight would
 * display one calendar day earlier in ET; 16:00 UTC is noon-ish ET and stays on
 * the intended day in both EST and EDT. Returns `null` for anything that isn't a
 * date-only string, so callers pick their own fallback (leave unchanged / clear
 * / parse-as-full-timestamp). Standardizes the ~dozen inline copies that had
 * drifted between T16 and T12 anchors (2026-08 cleanup).
 */
export function anchorDateOnlyIso(dateOnly: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? `${dateOnly}T16:00:00.000Z` : null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Milliseconds for a value that may be a bare DATE or a full timestamp.
 *
 * `new Date("2026-01-01")` is UTC MIDNIGHT. Render that in Eastern and you get
 * **31 December 2025** — a day early, and across a new year, the wrong YEAR on
 * a document. Every DATE column on the platform reaches these helpers:
 * proposal_due_at, follow_up_at, rfp_received_at, substantial_completion_date,
 * the AIA periods, the work-order and field-ops dates.
 *
 * Confirmed live: `bid-lifecycle-timeline` prints `Due {absoluteDate(
 * proposal_due_at)}`, and proposal_due_at is a DATE.
 *
 * A date-only string is already the calendar day somebody picked, so it is
 * anchored at 16:00 UTC — noon-ish ET, the same calendar day in both EST and
 * EDT — rather than converted. Real timestamps are left exactly as they are.
 * Same rule `etDateOf` applies in lib/date-et.ts; this is the other half of it,
 * for the formatters that live here.
 */
function msOf(iso: string): number {
  return new Date(DATE_ONLY.test(iso) ? `${iso}T16:00:00.000Z` : iso).getTime();
}

/**
 * "3 minutes ago" / "5 hours ago" / "yesterday" / "3d ago" style.
 * Falls back to a short absolute date once we're past ~14 days
 * (older-than-two-weeks reads more meaningfully as a date).
 */
export function relativeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = msOf(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  if (diff < 0) {
    // Future timestamp — return a compact "in X" form.
    const absDays = Math.floor(Math.abs(diff) / MS_PER_DAY);
    if (absDays === 0) return "today";
    if (absDays === 1) return "tomorrow";
    if (absDays < 7) return `in ${absDays}d`;
    if (absDays < 30) return `in ${Math.floor(absDays / 7)}w`;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }).format(new Date(t));
  }
  if (diff < MS_PER_MIN) return "just now";
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MIN)}m ago`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h ago`;
  const days = Math.floor(diff / MS_PER_DAY);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(t));
}

/**
 * Absolute date in ET, human-readable. Use in detail views + exports.
 * Aug 5, 2026 style.
 */
export function absoluteDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = msOf(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(t));
}

/**
 * Whole-day count from an ISO string to now, ET-anchored. Returns 0
 * for today, 1 for yesterday, negative for future dates.
 */
export function daysSinceIso(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = msOf(iso);
  if (!Number.isFinite(t)) return null;
  // CALENDAR days, not milliseconds ÷ 86,400,000.
  //
  // The raw division is wrong twice over. It measures elapsed time, so at 9am
  // "yesterday evening" is 14 hours ago and counts as 0 days — while a bare
  // DATE anchored at noon counts as −1 for TODAY. That second one is the
  // symptom the backlog recorded: "a proposal due today reads 1 day overdue".
  //
  // What every caller actually wants is how many times the date has changed in
  // Eastern, which is a subtraction between two calendar days.
  const dayOf = (ms: number) =>
    new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [ay, am, ad] = dayOf(now).split("-").map(Number);
  const [by, bm, bd] = dayOf(t).split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / MS_PER_DAY);
}

export { MS_PER_DAY };
