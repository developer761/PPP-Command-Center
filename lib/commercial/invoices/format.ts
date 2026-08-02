/**
 * Phase 3 · Invoicing — display formatters (pure functions; usable
 * anywhere client or server-side).
 */

/** Format cents as compact "$1.2M" / "$10.4k" / "$123" for KPI tiles.
 *  Karan 2026-07-07: $10,400 was rounding to "$10k" — dropping the
 *  $400 gave people a wrong at-a-glance number ("did they mean 10 or
 *  10.4?"). Show 1 decimal for anything under $100k so the readout
 *  matches the true value; drop the decimal above $100k where it
 *  reads as noise ($123.4k instead of $123k on a small tile). */
export function formatCentsCompact(cents: number): string {
  // Non-finite guard — a NaN/Infinity slipping in from a bad upstream value
  // should render "$0", never "$NaN"/"$InfinityM" on a KPI tile (2026-08 edge
  // audit).
  if (!Number.isFinite(cents) || cents === 0) return "$0";
  // Hoist the sign so negatives read "-$500", not "$-500" (matches
  // formatCentsFull). Balances can go negative on overpayment/credit.
  const neg = cents < 0;
  const dollars = Math.abs(cents) / 100;
  const body =
    // Billions tier so a $9.9B value reads "$9.9B", not "$9999.9M" overflowing
    // the tile.
    dollars >= 1_000_000_000
      ? `$${(dollars / 1_000_000_000).toFixed(1)}B`
      : dollars >= 1_000_000
      ? `$${(dollars / 1_000_000).toFixed(1)}M`
      : dollars >= 100_000
      ? `$${Math.round(dollars / 1_000)}k`
      : dollars >= 1_000
      ? // Trim a trailing "0" so $10,000 reads as "$10k" (not "$10.0k").
        `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}k`
      : `$${Math.round(dollars).toLocaleString()}`;
  return neg ? `-${body}` : body;
}

/** Format cents as full "$1,234.56" for line items + totals. Negatives read
 *  "-$1,234.56" (sign before the $), not "$-1,234.56". */
export function formatCentsFull(cents: number): string {
  const neg = cents < 0;
  const dollars = Math.abs(cents) / 100;
  const body = `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return neg ? `-${body}` : body;
}

/** Parse a dollar-string ("$1,234.56", "1234.56", "1234") into cents.
 *  Returns null on unparseable input. */
export function parseDollarsToCents(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "").trim();
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const asNum = parseFloat(cleaned);
  if (!Number.isFinite(asNum)) return null;
  return Math.round(asNum * 100);
}

/** "Jul 6, 2026" in America/New_York for invoice header dates. */
export function fmtEtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Days between two ISO timestamps. Negative = past. */
export function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}
