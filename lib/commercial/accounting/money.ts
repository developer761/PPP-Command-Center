/**
 * Money a person typed → cents, or NULL when it is not money.
 *
 * It used to return 0 for anything unparseable. For three of its callers that
 * was harmless — they rejected `cents <= 0` — but it is the wrong shape, and it
 * made "abc" and "nothing" the same value. Payroll is where that became
 * expensive: a Gusto cost of `N/A` pasted from a spreadsheet saved as $0.00,
 * cleared every blocker, and let the week post with that person's entire
 * payroll on no job, while the screen certified the split tied to the cent. The
 * guard written for exactly that — `if (!Number.isFinite(cents))` — could never
 * fire, because the helper had already turned NaN into 0.
 *
 * Returning null makes "not a number" distinguishable from "zero", which is the
 * distinction every caller actually needed.
 *
 * WHY IT LIVES HERE RATHER THAN IN THE PAGE. It was module-private inside
 * `app/commercial/accounting/page.tsx`, so the only way to test it was to read
 * the file and assert on its source — including counting how many times the
 * string `cents == null || cents <= 0` appeared. On 2026-10-15 a legitimate
 * change (a vendor credit is negative, so one caller now rejects `=== 0`
 * instead) took that count from three to two and the suite went red with
 * nothing broken. That is the exact failure this codebase has written down
 * twice: a test pinned to source text breaks on a refactor and sails through a
 * real regression. Exported, it gets tested by being called.
 */

/** Beyond this a bigint overflows Postgres and the raw error reaches the user. */
export const MAX_CENTS = 1_000_000_000_00;

export function dollarsToCents(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  /*
   * Accounting parentheses are negative — `(500)` means −500 on every statement
   * Mary handles, and silently reading it as 500 would be worse than rejecting
   * it outright.
   */
  const negative = /^\(.*\)$/.test(text);
  const bare = text.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  // Number("") is 0 and Number("1e5") is 100000 — neither is money somebody
  // typed, so the shape is checked before the value.
  if (!/^-?\d*\.?\d+$/.test(bare)) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  // `-Math.abs` rather than `* -1`: brackets around an already-negative number
  // must not cancel back to a positive.
  const magnitude = Math.round(n * 100);
  const cents = negative ? -Math.abs(magnitude) : magnitude;
  if (Math.abs(cents) > MAX_CENTS) return null;
  return cents;
}
