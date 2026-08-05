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
