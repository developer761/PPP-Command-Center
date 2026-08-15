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
