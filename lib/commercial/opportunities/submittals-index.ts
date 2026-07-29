import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import type { SubmittalStatus } from "./submittal-constants";

/**
 * Cross-account Submittals index (2026-07-28) — the global "all letters of
 * transmittal" list behind the sidebar Submittals item. Submittals themselves
 * live per-opportunity; this aggregates every live one across every GC so the
 * team has a single queue (awaiting-response floats to the top). Batched, no
 * N+1, and paginated past PostgREST's 1000-row cap. Service-role only.
 */

export type SubmittalIndexRow = {
  id: string;
  opportunityId: string;
  accountId: string;
  accountName: string;
  oppName: string;
  submittalNumber: number;
  revisionNumber: number;
  status: SubmittalStatus;
  toCompany: string | null;
  reSubject: string | null;
  itemCount: number;
  sentAt: string | null;
  responseReceivedAt: string | null;
  updatedAt: string;
  /** Sent to the GC/architect and no response yet — the actionable state. */
  awaiting: boolean;
};

/** submitted / under_review = ball is in the GC's court. */
const AWAITING_SUBMITTAL = new Set<string>(["submitted", "under_review"]);

async function paginateAll<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> }): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await make().range(from, from + PAGE - 1);
    const rows = (data as T[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function listAllSubmittals(
  opts: { search?: string; status?: string } = {}
): Promise<SubmittalIndexRow[]> {
  const sb = commercialDb();

  // 1. Submittals. Voided are hidden by default (sent-in-error); an explicit
  //    status filter can surface them.
  type SubRow = {
    id: string;
    opportunity_id: string;
    submittal_number: number;
    revision_number: number;
    status: SubmittalStatus;
    to_company: string | null;
    re_subject: string | null;
    sent_at: string | null;
    response_received_at: string | null;
    updated_at: string;
  };
  const subs = await paginateAll<SubRow>(() => {
    let q = sb
      .from("commercial_opp_submittals")
      .select(
        "id, opportunity_id, submittal_number, revision_number, status, to_company, re_subject, sent_at, response_received_at, updated_at"
      );
    if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
    else q = q.neq("status", "voided");
    return q.order("updated_at", { ascending: false });
  });
  if (subs.length === 0) return [];

  // 2. Parent opps (names + soft-delete/archive scope).
  const oppIds = [...new Set(subs.map((s) => s.opportunity_id))];
  type OppRow = {
    id: string;
    title: string | null;
    title_override: string | null;
    client_name: string | null;
    property_street: string | null;
    account_id: string;
    deleted_at: string | null;
    archived_at: string | null;
  };
  const opps = await paginateAll<OppRow>(() =>
    sb
      .from("commercial_opportunities")
      .select("id, title, title_override, client_name, property_street, account_id, deleted_at, archived_at")
      .in("id", oppIds)
  );
  const oppById = new Map(opps.filter((o) => !o.deleted_at && !o.archived_at).map((o) => [o.id, o]));

  // 3. Accounts (names + soft-delete scope).
  const acctIds = [...new Set([...oppById.values()].map((o) => o.account_id))];
  type AcctRow = { id: string; company_name: string | null; deleted_at: string | null };
  const accts = acctIds.length
    ? await paginateAll<AcctRow>(() =>
        sb.from("commercial_accounts").select("id, company_name, deleted_at").in("id", acctIds)
      )
    : [];
  const acctById = new Map(accts.filter((a) => !a.deleted_at).map((a) => [a.id, a]));

  // 4. Item counts (bulk, no N+1).
  const subIds = subs.map((s) => s.id);
  const items = await paginateAll<{ submittal_id: string }>(() =>
    sb.from("commercial_opp_submittal_items").select("submittal_id").in("submittal_id", subIds)
  );
  const countBy = new Map<string, number>();
  for (const r of items) countBy.set(r.submittal_id, (countBy.get(r.submittal_id) ?? 0) + 1);

  // 5. Assemble — drop any submittal whose opp or account is gone.
  let rows: SubmittalIndexRow[] = [];
  for (const s of subs) {
    const opp = oppById.get(s.opportunity_id);
    if (!opp) continue;
    const acct = acctById.get(opp.account_id);
    if (!acct) continue;
    rows.push({
      id: s.id,
      opportunityId: s.opportunity_id,
      accountId: opp.account_id,
      accountName: acct.company_name ?? "",
      oppName: derivedOppName(opp as never, acct.company_name ?? null),
      submittalNumber: s.submittal_number,
      revisionNumber: s.revision_number,
      status: s.status,
      toCompany: s.to_company,
      reSubject: s.re_subject,
      itemCount: countBy.get(s.id) ?? 0,
      sentAt: s.sent_at,
      responseReceivedAt: s.response_received_at,
      updatedAt: s.updated_at,
      awaiting: AWAITING_SUBMITTAL.has(s.status),
    });
  }

  // 6. Search (JS, over the fully-paginated set).
  if (opts.search && opts.search.trim()) {
    const t = opts.search.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.oppName.toLowerCase().includes(t) ||
        r.accountName.toLowerCase().includes(t) ||
        (r.toCompany ?? "").toLowerCase().includes(t) ||
        (r.reSubject ?? "").toLowerCase().includes(t) ||
        `#${r.submittalNumber}`.includes(t)
    );
  }

  // 7. Awaiting-response floats to the top, then newest-updated.
  rows.sort((a, b) =>
    a.awaiting === b.awaiting ? b.updatedAt.localeCompare(a.updatedAt) : a.awaiting ? -1 : 1
  );
  return rows;
}

export function summarizeSubmittals(rows: SubmittalIndexRow[]): {
  total: number;
  awaiting: number;
  approved: number;
  revised: number;
} {
  let awaiting = 0;
  let approved = 0;
  let revised = 0;
  for (const r of rows) {
    if (r.awaiting) awaiting += 1;
    if (r.status === "approved" || r.status === "approved_as_noted") approved += 1;
    if (r.status === "revise_and_resubmit") revised += 1;
  }
  return { total: rows.length, awaiting, approved, revised };
}
