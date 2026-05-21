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
