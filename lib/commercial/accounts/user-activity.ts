import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";

/**
 * "RECENTLY ACTIVE" FROM WHAT PEOPLE DID, not from `updated_at`.
 *
 * The accounts list counted an account active when the overview view's
 * `last_activity_at` fell in the window — a GREATEST() over the account's and
 * its deals' `updated_at`. Bulk backfills touch those columns too: on
 * 2026-10-16 the tile read "Recently active 82 in the last 7 days" of 84
 * accounts because one run stamped 79 accounts at 2026-10-14 18:14 UTC and
 * another stamped 134 opportunities at 2026-10-13 20:22. Nobody had worked 82
 * GCs that week.
 *
 * `commercial_audit_log` records every write the app makes, with the user who
 * made it. Writes with no user are system work (imports, crons, refolds), so
 * only user-attributed rows count here. Each row is tied to a GC through the
 * record itself: the account row, an `account_id` on it, or the deal it
 * belongs to (`opportunity_id`, or the opportunity row). Rows that reach no
 * account (a line item whose parent is logged separately) are skipped — the
 * parent's own entry already counts the activity.
 */

export type AuditActivityRow = {
  table_name: string;
  row_id: string;
  user_id: string | null;
  at: string;
  after_json: Record<string, unknown> | null;
  before_json: Record<string, unknown> | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Which GC an audit row concerns, or null. Pure, for tests. */
export function accountIdForAuditRow(
  row: AuditActivityRow,
  accountIdByOpp: Map<string, string>,
): string | null {
  if (row.table_name === "commercial_accounts") return row.row_id;
  const rec = row.after_json ?? row.before_json ?? {};
  const direct = str(rec.account_id);
  if (direct) return direct;
  if (row.table_name === "commercial_opportunities") return accountIdByOpp.get(row.row_id) ?? null;
  const opp = str(rec.opportunity_id);
  return opp ? accountIdByOpp.get(opp) ?? null : null;
}

/** Latest user-made activity per GC. Pure, for tests. */
export function latestUserActivityByAccount(
  rows: AuditActivityRow[],
  accountIdByOpp: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.user_id) continue;
    const acct = accountIdForAuditRow(r, accountIdByOpp);
    if (!acct) continue;
    const prev = out.get(acct);
    if (!prev || r.at > prev) out.set(acct, r.at);
  }
  return out;
}

/**
 * Account id → ISO instant of the latest user-made write in the last
 * `windowDays` days. Reads one extra day so the caller's ET-calendar-day test
 * decides the edge rather than a UTC instant.
 */
export async function loadUserActivityByAccount(windowDays: number): Promise<Map<string, string>> {
  const sinceIso = new Date(Date.now() - (windowDays + 1) * 86_400_000).toISOString();
  const sb = commercialDb();
  const [rows, opps] = await Promise.all([
    paginateAll<AuditActivityRow>(() =>
      sb
        .from("commercial_audit_log")
        .select("table_name, row_id, user_id, at, after_json, before_json")
        .gte("at", sinceIso)
        .not("user_id", "is", null)
        .order("at", { ascending: true }),
    ),
    paginateAll<{ id: string; account_id: string }>(() =>
      sb.from("commercial_opportunities").select("id, account_id").order("id", { ascending: true }),
    ),
  ]);
  return latestUserActivityByAccount(rows, new Map(opps.map((o) => [o.id, o.account_id])));
}
