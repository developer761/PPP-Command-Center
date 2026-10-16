/**
 * A scripted stand-in for the supabase query builder, for SEAM tests of write
 * paths whose bug is "the second write failed and nobody looked".
 *
 * Those bugs cannot be reached from a real database on demand — you cannot ask
 * Postgres to fail the third statement of a request — and every one of them
 * shipped green because the suite never saw a returned `{ error }`. So each
 * query here is recorded as a `Call` and answered by the test's `respond`
 * function, which can fail exactly the statement under test and let the rest
 * succeed. The code under test is the real code; only the wire is fake.
 *
 * Supabase never throws from a query: it RESOLVES with `{ data, error }`. This
 * fake does the same, which is the whole point — a `.catch()` around one of
 * these catches nothing.
 */

export type Op = "select" | "insert" | "update" | "delete" | "upsert";

export type Call = {
  table: string;
  op: Op;
  payload?: unknown;
  /** Every filter applied, as [method, column, value]. */
  filters: Array<[string, string, unknown]>;
  /** A write with `.select(...)` chained, i.e. one that returns its rows. */
  returning: boolean;
  single: boolean;
};

export type Answer = { data?: unknown; error?: { message: string } | null; count?: number | null };

export type Responder = (call: Call) => Answer | undefined;

const FILTERS = [
  "eq", "neq", "is", "in", "not", "gt", "gte", "lt", "lte", "like", "ilike",
  "or", "filter", "match", "contains", "order", "limit", "range",
] as const;

/** `calls` may be passed in so every `commercialDb()` a module builds logs to
 *  one shared list. */
export function fakeSupabase(respond: Responder, calls: Call[] = []) {
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [], returning: false, single: false };
      let opSet = false;
      const builder: Record<string, unknown> = {};
      const setOp = (op: Op, payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        opSet = true;
        return builder;
      };
      builder.select = () => {
        if (opSet && call.op !== "select") call.returning = true;
        else opSet = true;
        return builder;
      };
      builder.insert = (p: unknown) => setOp("insert", p);
      builder.update = (p: unknown) => setOp("update", p);
      builder.upsert = (p: unknown) => setOp("upsert", p);
      builder.delete = () => setOp("delete");
      for (const f of FILTERS) {
        builder[f] = (col?: unknown, val?: unknown, extra?: unknown) => {
          call.filters.push([f, String(col), extra !== undefined ? [val, extra] : val]);
          return builder;
        };
      }
      builder.maybeSingle = () => {
        call.single = true;
        return builder;
      };
      builder.single = builder.maybeSingle;
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        calls.push(call);
        try {
          const a = respond(call) ?? {};
          return Promise.resolve({
            data: a.data === undefined ? (call.single ? null : []) : a.data,
            error: a.error ?? null,
            count: a.count ?? null,
          }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      };
      return builder;
    },
  };
  return { client, calls };
}

/** The value a call filtered `column` on with `method` (default `eq`). */
export function filterValue(call: Call, column: string, method = "eq"): unknown {
  return call.filters.find(([m, c]) => m === method && c === column)?.[2];
}

/** True when the call is a write of `op` on `table`. */
export const isWrite = (call: Call, table: string, op: Op) => call.table === table && call.op === op;
