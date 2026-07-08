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
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (Math.abs(dollars) >= 100_000) return `$${Math.round(dollars / 1_000)}k`;
  if (Math.abs(dollars) >= 1_000) {
    const thousands = dollars / 1_000;
    // Trim a trailing "0" so $10,000 reads as "$10k" (not "$10.0k").
    const trimmed = thousands.toFixed(1).replace(/\.0$/, "");
    return `$${trimmed}k`;
  }
  return `$${Math.round(dollars).toLocaleString()}`;
}

/** Format cents as full "$1,234.56" for line items + totals. */
export function formatCentsFull(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
