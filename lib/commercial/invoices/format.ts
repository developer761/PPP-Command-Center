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
  // Same guard `formatCentsCompact` got in the 2026-08 edge audit. This one was
  // missed, and it is the helper used for line items and totals — the places a
  // "$NaN" would be most alarming to a customer reading an invoice.
  if (!Number.isFinite(cents)) return "$0.00";
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

/**
 * Whole CALENDAR days between two dates, in Eastern time. Negative = past.
 *
 * This was a raw 24-hour instant diff, which is wrong for a due date. `due_at`
 * is a calendar date — midnight UTC — so at noon in New York on the day
 * something is due, the difference is already negative and it floored to −1:
 * an invoice read "1 day overdue" on its own due date, and the header showed
 * "Sent" and "1 day overdue" side by side. The status badge was fixed for this
 * months ago; this path was missed, so the two disagreed on the same screen.
 *
 * Bare `YYYY-MM-DD` values are taken as written. Converting them through a
 * timezone would shift them back a day, which is the same bug from the other
 * direction.
 */
export function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  const a = etCalendarDate(fromIso);
  const b = etCalendarDate(toIso);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** The ET calendar date for an instant, or a bare date passed through unchanged. */
function etCalendarDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso.slice(0, 10)) && !iso.includes("T")) return iso.slice(0, 10);
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
