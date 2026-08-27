/**
 * A trustworthy "now" for the report builders.
 *
 * Every report takes `nowMs = Date.now()` as its FIRST parameter and filters as
 * its second — an easy pair to swap, and swapping them used to throw "Invalid
 * time value" from `new Date(nowMs).toISOString()` three frames deep, taking
 * the whole page down. Every caller passes it correctly today; this exists so
 * that stops being load-bearing.
 *
 * A bad clock reading is never a reason to refuse to show someone what they are
 * owed — which is the house rule: warn, don't reject.
 */
export function safeNowMs(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  console.warn(
    `[${label}] ignored a non-numeric "now" (${JSON.stringify(value)}) — using the current time`
  );
  return Date.now();
}
