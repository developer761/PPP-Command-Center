/**
 * WorkOrder.Product_Lines__c — what the hub actually ordered.
 *
 * KATE, R6.2. The paint line has a lifecycle with two distinct answers, and
 * until now Salesforce could only hold one of them:
 *
 *   1. The estimator picks a line on the quote  → Quote.MaterialType__c
 *   2. Closing won copies it to the work order  → WorkOrder.MaterialType__c
 *   3. The hub reads that as the AM's starting default
 *   4. The AM adjusts it, per side of the job
 *   5. The hub writes THAT here — and never touches MaterialType__c
 *
 * Keeping them apart is the point: MaterialType__c stays the estimator's
 * answer, untouched, so what was SOLD can always be read next to what was
 * ORDERED. Overwriting it destroyed that comparison.
 *
 * WHY TEXT AND NOT THE PICKLIST. MaterialType__c is a restricted picklist whose
 * vocabulary carries a scope — "Regal Select Exterior" — while the hub works in
 * line names alone. Every write had to be translated, and lines with no
 * equivalent (Ben, Mooreglo, Mooregard, Moore Life) were dropped rather than
 * guessed at. It also holds ONE value, so a job with both an interior and an
 * exterior line could not be represented at all: the exterior choice was
 * recorded in the hub, reached the vendor order, and never reached Salesforce.
 *
 * A plain text field has neither limit — no vocabulary to keep in sync with an
 * org picklist, and no cap on how many lines a job carries.
 */

/** Salesforce text fields default to 255 characters. */
export const PRODUCT_LINES_MAX = 255;

export type ProductLineSelection = {
  interior?: string | null;
  exterior?: string | null;
};

/**
 * Kate's format: `Interior: Regal Select | Exterior: Woodluxe`.
 *
 * Only the side that applies is included — an interior-only job writes
 * `Interior: Regal Select` and nothing else, rather than an empty "Exterior:"
 * that reads like a missing answer.
 *
 * Returns "" when neither side is set, which callers treat as "don't write"
 * rather than "write empty": blanking a value nobody chose to clear would lose
 * a real answer on every submit that happened to skip the picker.
 */
export function formatProductLines(sel: ProductLineSelection): string {
  const parts: string[] = [];
  const interior = (sel.interior ?? "").trim();
  const exterior = (sel.exterior ?? "").trim();
  if (interior) parts.push(`Interior: ${interior}`);
  if (exterior) parts.push(`Exterior: ${exterior}`);
  const out = parts.join(" | ");
  // A line name long enough to overflow means something is wrong upstream, but
  // truncating beats STRING_TOO_LONG rejecting the whole write — which would
  // take the colours down with it, since they share one batch.
  return out.length <= PRODUCT_LINES_MAX ? out : out.slice(0, PRODUCT_LINES_MAX);
}

/**
 * Read a stored value back into its two sides.
 *
 * Exists so the hub can show what Salesforce currently holds without a second
 * source of truth, and so a round trip can be asserted in tests.
 */
export function parseProductLines(value: string | null | undefined): ProductLineSelection {
  const out: ProductLineSelection = {};
  for (const chunk of (value ?? "").split("|")) {
    const m = chunk.match(/^\s*(Interior|Exterior)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "interior") out.interior = m[2];
    else out.exterior = m[2];
  }
  return out;
}
