/**
 * Human-readable timestamp for list rows.
 *
 * Renders "3d ago" / "yesterday" / "just now" as the visible text, with
 * a full absolute date + time in a `title` tooltip + `<time datetime>`
 * attribute for machine-readable exports.
 *
 * Server component — no client-side JS. Computes against Date.now() at
 * render time (day-level resolution so client/server render drift is
 * imperceptible).
 *
 * Karan 2026-07-11 (signature-moments batch): unified relative-time
 * across every list surface. Detail pages continue to render absolute
 * dates via `absoluteDate` — this is for compact lists only.
 */

import { relativeAgo, absoluteDate } from "@/lib/commercial/dates";

export function RelativeDate({
  iso,
  className = "",
  fallback = "—",
}: {
  iso: string | null | undefined;
  className?: string;
  fallback?: string;
}) {
  if (!iso) return <span className={className}>{fallback}</span>;
  const relative = relativeAgo(iso);
  const absolute = absoluteDate(iso);
  return (
    <time
      dateTime={iso}
      title={absolute}
      className={className}
    >
      {relative}
    </time>
  );
}
