/**
 * The round-trip of Accounting's money-out forms, in one place.
 *
 * A refused "Record a purchase" or "Record a labor payment" redirects back to
 * the page, and the values travel on the URL. The FORM field each one came
 * from, the URL key it rides on and the prop the form reads it back from are
 * the same list here — so a field added to one side is not quietly dropped on
 * the way back (the shape of bug that has shipped on this platform before).
 *
 * Client-safe: the forms import the type, the server action imports the list.
 */

export type SpendPreserve = Partial<
  Record<
    | "sp_job"
    | "sp_vendor"
    | "sp_amt"
    | "sp_date"
    | "sp_cat"
    | "sp_cat_other"
    | "sp_lcat"
    | "sp_hours"
    | "sp_desc"
    | "sp_reimb",
    string
  >
>;

/** [url key, form field name, max length]. */
export const SPEND_PRESERVE_KEYS: readonly [keyof SpendPreserve, string, number][] = [
  ["sp_job", "opportunity_id", 40],
  ["sp_vendor", "vendor", 200],
  ["sp_amt", "amount", 40],
  ["sp_date", "purchased_at", 10],
  ["sp_cat", "category", 40],
  ["sp_cat_other", "category_other", 120],
  ["sp_lcat", "labor_category", 40],
  ["sp_hours", "hours", 20],
  ["sp_desc", "description", 1000],
  ["sp_reimb", "reimburse_to", 120],
];

/** Read the round-tripped values back off the page's search params. */
export function spendPreserveFromParams(
  get: (key: string) => string | undefined,
): SpendPreserve | undefined {
  const out: SpendPreserve = {};
  let any = false;
  for (const [key] of SPEND_PRESERVE_KEYS) {
    const v = get(key);
    if (v) {
      out[key] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}
