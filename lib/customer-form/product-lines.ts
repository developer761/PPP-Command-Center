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
  interior?: string | string[] | null;
  exterior?: string | string[] | null;
};

/**
 * Trim, drop blanks, de-duplicate, keep first-seen order.
 *
 * Several lines per SIDE is a real case and always was — Katie's reason for
 * deleting the single "Use Default" selector on 2026-09-08 was precisely that
 * one control cannot speak for a job mixing Ultra Spec and Regal. The old
 * single-string shape could not record that job either; it recorded whichever
 * line the AM happened to pick. The docblock above already anticipated this:
 * a text field has "no cap on how many lines a job carries".
 */
function normalizeSide(v: string | string[] | null | undefined): string[] {
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const s = (raw ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

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
  const interior = normalizeSide(sel.interior);
  const exterior = normalizeSide(sel.exterior);
  // Several on a side are comma-joined inside their label, so the shape Kate
  // specified still reads the same for the ordinary one-line-per-side job:
  //   Interior: Regal Select | Exterior: Woodluxe
  //   Interior: Regal Select, Ultra Spec Interior
  if (interior.length) parts.push(`Interior: ${interior.join(", ")}`);
  if (exterior.length) parts.push(`Exterior: ${exterior.join(", ")}`);
  const out = parts.join(" | ");
  // A line name long enough to overflow means something is wrong upstream, but
  // truncating beats STRING_TOO_LONG rejecting the whole write — which would
  // take the colors down with it, since they share one batch.
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

/**
 * The product lines an ORDER actually contains, split by side.
 *
 * WHY THIS EXISTS. Until 2026-10-09 `Product_Lines__c` — the field that
 * records what was ORDERED — was written from exactly one place: the product
 * line an Account Manager picked on Internal Entry, before any ordering had
 * happened. Kate, 2026-10-09: "I still think removing the selector from the
 * AMs' Internal Entry form would be good because it takes their involvement
 * out of the equation."
 *
 * She is right, and the selector cannot simply be deleted: it was the ONLY
 * writer of her own R6.2 field, so removing it would have silently stopped
 * the writeback. This derives the same answer from the real per-color
 * selections at send time instead, which is both what the field claims to
 * mean and strictly better evidence — an AM's single up-front guess versus
 * what the vendor was actually asked to supply.
 *
 * `mainMaterialType` is included only as a fallback for orders saved before
 * the per-color pickers existed; nothing sets it now.
 */
export function productLinesFromOrder(
  order: {
    materialTypeOverrides?: Record<string, string> | null;
    mainMaterialType?: string | null;
  },
  isExterior: (value: string) => boolean
): { interior: string[]; exterior: string[] } {
  const values = [
    ...Object.values(order.materialTypeOverrides ?? {}),
    order.mainMaterialType ?? "",
  ];
  const interior: string[] = [];
  const exterior: string[] = [];
  for (const raw of values) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    (isExterior(v) ? exterior : interior).push(v);
  }
  // normalizeSide in formatProductLines de-duplicates; returning the raw
  // order here keeps this function honest about what it saw.
  return { interior, exterior };
}
