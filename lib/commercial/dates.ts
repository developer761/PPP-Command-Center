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
 * "3 minutes ago" / "5 hours ago" / "yesterday" / "3d ago" style.
 * Falls back to a short absolute date once we're past ~14 days
 * (older-than-two-weeks reads more meaningfully as a date).
 */
export function relativeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
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
  const t = new Date(iso).getTime();
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
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / MS_PER_DAY);
}

/**
 * "Days idle" heat class for a row/card background. Karan 2026-07-11:
 * silent signal that draws the eye to stale work without adding chips
 * or badges. Threshold: 7 days = amber, 14 days = rose.
 *
 * Returns a Tailwind class list (bg + optional left border) suitable
 * for merging into a row's className. Empty string when the row is
 * fresh — callers can safely template it in without stripping.
 */
export function idleHeatBg(daysIdle: number | null | undefined): string {
  if (daysIdle == null || daysIdle < 7) return "";
  if (daysIdle < 14) return "bg-amber-50/50";
  return "bg-rose-50/50";
}

export function idleHeatBorder(daysIdle: number | null | undefined): string {
  if (daysIdle == null || daysIdle < 7) return "";
  if (daysIdle < 14) return "border-l-2 border-amber-400";
  return "border-l-2 border-rose-400";
}

export { MS_PER_DAY };
