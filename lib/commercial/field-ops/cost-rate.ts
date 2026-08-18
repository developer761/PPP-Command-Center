/**
 * Parse a burdened $/hr cost rate.
 *
 * Three outcomes, deliberately distinct — the old version collapsed the last
 * two into `null`, and every caller then did `if (rate != null) save it`. So
 * typing "fourty two" or "$4.2.5" saved NOTHING and still reported success.
 * The employee ends up with no cost rate, their hours cost $0, and job margin
 * silently reads high — which is the exact condition the "unrated hours"
 * warning elsewhere in the platform exists to flag.
 *
 *   { blank: true }   — nothing typed. Legitimate; set it later.
 *   { cents: n }      — a good value.
 *   { error }         — they typed something and it isn't a rate. Say so.
 */
export function parseCostRateToCents(
  raw: string
): { blank: true } | { cents: number } | { error: string } {
  const typed = raw.trim();
  if (!typed) return { blank: true };
  const cleaned = typed.replace(/[^0-9.]/g, "");
  const n = Number(cleaned);
  if (!cleaned || !Number.isFinite(n) || n <= 0) {
    return { error: `"${typed.slice(0, 20)}" isn't a cost rate. Enter dollars per hour, like 42.00 — or leave it blank to set later.` };
  }
  // A burdened hourly rate above this is a typo (a misplaced decimal turns $42
  // into $4,200 and quietly wrecks every job's margin). Cheap to catch here.
  if (n > 500) {
    return { error: `$${n.toFixed(2)}/hr looks like a typo — check the decimal point.` };
  }
  return { cents: Math.round(n * 100) };
}
