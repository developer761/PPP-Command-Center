import "server-only";

/**
 * Fetch EVERY row of a PostgREST select, paging past the 1000-row cap. Supabase
 * silently truncates a query to 1000 rows by default, so any unbounded list
 * (invoices, opportunities, change orders, line items…) would quietly drop data
 * once a customer crosses that count. Pass a thunk that builds the query fresh
 * each page (so `.range()` applies cleanly); returns the concatenated rows.
 *
 *   const rows = await paginateAll<Row>(() =>
 *     sb.from("t").select("*").eq("x", y).order("created_at"));
 *
 * Extracted 2026-08 from the duplicate copies in projects/db + submittals-index.
 */
export async function paginateAll<T>(
  make: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> }
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    // THROW, never swallow. This helper backs the money rollups (invoice
    // totals, AR, payroll hours, purchase costs). Discarding the error made a
    // failed page look like an empty one: a transient PostgREST blip on the
    // first page rendered "Invoiced $0.00 / Balance $0.00" on a real account,
    // and a failure on page 2 silently truncated the totals to 1000 rows. An
    // error page is recoverable; a confidently wrong dollar figure is not.
    if (error) {
      const msg =
        (error as { message?: string })?.message ?? String(error);
      throw new Error(`paginateAll failed at offset ${from}: ${msg}`);
    }
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Look up rows BY ID, in chunks, without silently losing any.
 *
 * The companion mistake to the one above, and the more dangerous of the two
 * because `paginateAll` working perfectly is what triggers it:
 *
 *     const payments = await paginateAll(...);            // every payment
 *     const ids = [...new Set(payments.map(p => p.invoice_id))];
 *     const { data } = await sb.from("invoices").in("id", ids);   // ← capped
 *     for (const p of payments) {
 *       const inv = byId.get(p.invoice_id);
 *       if (!inv) continue;                               // ← money vanishes
 *     }
 *
 * That `.in()` is subject to the same 1000-row cap, and the URL it builds
 * (~37 bytes per UUID) hits a 414 well before that. Either way the lookup comes
 * back short, the `continue` drops those rows, and the total is quietly wrong.
 * The better the pagination above it works, the more certainly the lookup
 * below it fails — so the two must be fixed together or not at all.
 *
 * Errors THROW, for the reason `paginateAll` gives: a `?? []` here turns a
 * failed lookup into an empty map, and an empty map turns every payment into a
 * skipped one. That renders "$0.00 in" on a month with real money in it, and
 * nothing on the screen looks wrong.
 *
 * 200 per chunk matches the batch size already used for Salesforce IN() and
 * the vendor/e-sign lookups.
 */
export async function selectByIds<T>(
  ids: readonly string[],
  make: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
  label = "selectByIds"
): Promise<T[]> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return [];
  const CHUNK = 200;
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await make(unique.slice(i, i + CHUNK));
    if (error) {
      const msg = (error as { message?: string })?.message ?? String(error);
      throw new Error(`${label} failed on ids ${i}-${i + CHUNK}: ${msg}`);
    }
    out.push(...(((data as T[] | null) ?? [])));
  }
  return out;
}
