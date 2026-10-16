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
  /*
   * 🔴 A NEGATIVE NUMBER IS NOT A FORMULA, AND QUOTING IT BREAKS THE SUM.
   *
   * The injection guard matched a leading `-`, which `-113060.78` also starts
   * with, so every negative money figure went out as the text `'-113060.78`.
   * Measured on the live October ledger: 124 of 129 data rows plus the MONEY
   * OUT and NET totals. `=SUM(E:E)` in Excel then silently skips all of them
   * and returns the money-IN side only.
   *
   * That defeats the stated purpose of the file. transactions-export.ts says
   * so in as many words: "Money out prints negative, so a spreadsheet SUM over
   * the column is the net." It isn't, and the accountant gets a column that
   * looks fine, totals wrong, and gives no sign of either.
   *
   * Same damage on Margin and Margin % in job-costs, jobs and geography.
   *
   * So a plain decimal number is exempt. `-` followed by anything else is
   * still prefixed: `=cmd|'/c calc'!A1` and `-1+1` are untouched, because
   * neither matches a bare number. The guard keeps its whole job; it stops
   * taking the accountant's arithmetic with it.
   */
  const isPlainNumber = /^-?\d+(\.\d+)?$/.test(raw);
  const s = !isPlainNumber && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${s.replace(/"/g, '""')}"`;
}
