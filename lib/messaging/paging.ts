/**
 * Reading every row, against a database that will quietly give you a thousand.
 *
 * Its own module, and not part of db.ts, because the callers that most need it
 * are the ones that have no business importing the data layer — the gate
 * counting a handset's messages before it is allowed to send, the enrolment
 * pass deciding which conversations to end. A pager is arithmetic over a query
 * builder; it should not drag an inbox with it.
 */
/**
 * Read every row, not the first thousand.
 *
 * PostgREST caps an unbounded select at 1,000 rows and says nothing about it —
 * no error, no flag, just a short array. A query that counts things then
 * quietly counts the first thousand of them, and the number on the screen is
 * wrong in a direction nobody can see.
 *
 * loadOptOutRates was doing exactly that: reading the whole conversations
 * table to build the DENOMINATOR of the opt-out rate. Truncate the denominator
 * while the numerator stays whole and the rate over-reports — which on that
 * screen means telling somebody to pause a number that is fine. Harmless at
 * ten conversations; wrong within about a week at 171 leads a day.
 *
 * Pages explicitly. The last page is the one shorter than the page size, which
 * is also how it stops on an exact multiple.
 */
const PAGE = 1000;

export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    // A runaway guard. Nothing here should ever reach this, and looping
    // forever against a paging bug is worse than a short answer that throws.
    if (out.length > 200_000) throw new Error(`${label}: refusing to read more than 200,000 rows`);
  }
}

/**
 * Every row for a list of ids — chunked over the ids AND paged over the rows.
 *
 * .in() bounds the filter and not the result, which is the trap. Asking for
 * the messages of 400 conversations returns every message in all of them, so
 * the thousand-row cap is reached with the id list nowhere near it, and the
 * rows that fall off are not a random sample: they are whatever sorts last.
 * The aging report lost the oldest threads' reply times this way, and every
 * one of them then aged wrongly on the screen a person triages from.
 *
 * The chunking is a second, separate failure. A .in() carrying a few thousand
 * UUIDs is a request URL tens of kilobytes long, and that one at least fails
 * loudly instead of quietly — but only once somebody has that much data.
 *
 * `build` MUST order by something unique. PostgREST ranges without a stable
 * sort do not return the rows the previous page missed; they return an
 * arbitrary window, so pages overlap and skip. That exact omission is what
 * made the PII sweep report ALL CLEAN over planted data, twice.
 */
export async function selectAllIn<T>(
  ids: string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
  chunkSize = 200
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    out.push(...await selectAll<T>((from, to) => build(chunk, from, to), label));
  }
  return out;
}
