/**
 * Smart money formatter. Input is in thousands ($K).
 * Examples:
 *   0.3   → "$300"
 *   12    → "$12K"
 *   1500  → "$1.5M"
 *   45155 → "$45.2M"
 *
 * Single source of truth — use this everywhere instead of inline `${v}K`.
 * At PPP scale (single deals → tens of $M lifetime), values can span 4 orders
 * of magnitude on one screen, so static `K` suffix renders things like "$45155K"
 * which is unreadable.
 */
export function fmtMoneyK(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${(v / 1000).toFixed(1)}M`;
  if (abs >= 1) return `$${Math.round(v)}K`;
  return `$${Math.round(v * 1000)}`;
}

/**
 * "Jun 8" — short month + day, no year. Use everywhere a UI surfaces a
 * recent date that the reader will read in same-year context.
 *
 * Accepts Date | ISO string | epoch ms | null. Returns "" on invalid input
 * so callers can `{date && <span>{fmtMonthDay(date)}</span>}` cleanly.
 *
 * Locale pinned to en-US for deterministic test output. Timezone defaults
 * to the runtime zone (browser local, server's process zone). Pass
 * `{ timeZone: "UTC" }` for date-only fields stored as `YYYY-MM-DD` so
 * a Jun 8 close-date doesn't shift to Jun 7 in EST.
 */
export function fmtMonthDay(
  input: Date | string | number | null | undefined,
  opts?: { timeZone?: string }
): string {
  if (input == null) return "";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: opts?.timeZone,
  });
}

/**
 * "Jun 2026" — short month + year. For monthly aggregations / period chips.
 * Same null/invalid handling + timezone semantics as `fmtMonthDay`.
 */
export function fmtMonthYear(
  input: Date | string | number | null | undefined,
  opts?: { timeZone?: string }
): string {
  if (input == null) return "";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: opts?.timeZone,
  });
}
