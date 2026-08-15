/**
 * The ONE CSV field escaper for the Commercial platform.
 *
 * There were seven copies of this: two hardened (accounts + opportunities
 * export) and five that only quoted on `[",\n]` — the payroll export and the
 * four report exports. Those five were missing both halves of the job:
 *
 *  1. **Formula injection.** A value starting `= + - @ TAB CR` is executed as a
 *     formula by Excel / LibreOffice / Sheets. A GC named `=cmd|'/c calc'!A1`,
 *     or a crew display name pasted from a spreadsheet, fires on open — and the
 *     payroll CSV is the one file that leaves the building, to an outside
 *     payroll processor.
 *  2. **Carriage returns.** Lines are joined with `\r\n`, but `\r` wasn't in
 *     the quote trigger, so an interior CR in a name split one row into two and
 *     shifted every column after it.
 *
 * Prefixing with a single quote neutralizes the formula — Excel renders the
 * literal text without firing the formula engine. Always quoting is simpler to
 * reason about than conditional quoting and is valid CSV either way.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${s.replace(/"/g, '""')}"`;
}
