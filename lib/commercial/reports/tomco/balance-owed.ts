import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";

/**
 * "Balance Owed" — Tomco's, reproduced.
 *
 * Brendan and Mary both run this one, grouped differently: he groups by owner
 * then status to work his call list, she groups by GC then status to chase the
 * money. Same twelve records either way, so both groupings are offered here and
 * the totals cannot move between them.
 *
 * WHICH TWELVE: Salesforce filters to work orders that are On Hold or Complete
 * Balance Owed — the jobs where the painting is done (or stopped) and the money
 * is not in. That is `wip_on_hold` and `completed_and_invoiced` here, and it
 * lands on Salesforce's own printed figures exactly:
 *
 *   12 records · charges $358,616.47 · paid $248,079.60 · owed $110,536.87
 *
 * Verified against the live database on 2026-09-16, to the cent, including the
 * 10/2 split between the two statuses.
 */

export type BalanceOwedRow = {
  oppId: string;
  accountId: string;
  accountName: string;
  oppName: string;
  status: string;
  workOrderNumber: string | null;
  phone: string | null;
  chargesCents: number;
  paidCents: number;
  balanceCents: number;
  /** Days since the job was substantially complete — SF's "Final Balance Aging". */
  agingDays: number | null;
};

/** The two work-order states Salesforce's filter keeps. */
const OWED_SUB_STATUSES = ["completed_and_invoiced", "wip_on_hold"] as const;

const STATUS_LABEL: Record<string, string> = {
  completed_and_invoiced: "Complete Balance Owed",
  wip_on_hold: "On Hold",
};

export async function getBalanceOwedRows(): Promise<BalanceOwedRow[]> {
  const sb = commercialDb();

  const opps = await paginateAll<{
    id: string;
    account_id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    sub_status: string;
    ppp_job_number: string | null;
    property_street: string | null;
    property_city: string | null;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select("id, account_id, title, client_name, title_override, title_override_mode, sub_status, ppp_job_number, property_street, property_city")
      .in("sub_status", OWED_SUB_STATUSES)
      .is("deleted_at", null)
      .order("id", { ascending: true })
  );
  if (opps.length === 0) return [];

  const oppIds = opps.map((o) => o.id);
  const accountIds = [...new Set(opps.map((o) => o.account_id))];

  const [invoices, accounts, projects] = await Promise.all([
    paginateAll<{ opportunity_id: string; total_cents: number; paid_cents: number; balance_cents: number }>(() =>
      sb
        .from("commercial_invoices")
        .select("opportunity_id, total_cents, paid_cents, balance_cents")
        .in("opportunity_id", oppIds)
        .is("deleted_at", null)
        .order("id", { ascending: true })
    ),
    sb
      .from("commercial_accounts")
      .select("id, company_name, phone")
      .in("id", accountIds)
      .then((r) => (r.data ?? []) as { id: string; company_name: string | null; phone: string | null }[]),
    paginateAll<{ opportunity_id: string; substantially_complete_at: string | null }>(() =>
      sb
        .from("commercial_projects")
        .select("opportunity_id, substantially_complete_at")
        .in("opportunity_id", oppIds)
        .order("id", { ascending: true })
    ),
  ]);

  const money = new Map<string, { t: number; p: number; b: number }>();
  for (const i of invoices) {
    const e = money.get(i.opportunity_id) ?? { t: 0, p: 0, b: 0 };
    e.t += Number(i.total_cents);
    e.p += Number(i.paid_cents);
    e.b += Number(i.balance_cents);
    money.set(i.opportunity_id, e);
  }
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const doneAt = new Map(projects.map((p) => [p.opportunity_id, p.substantially_complete_at]));
  const today = Date.now();

  return opps.map((o) => {
    const m = money.get(o.id) ?? { t: 0, p: 0, b: 0 };
    const a = acct.get(o.account_id);
    const done = doneAt.get(o.id);
    return {
      oppId: o.id,
      accountId: o.account_id,
      accountName: (a?.company_name ?? "").trim() || "Unassigned account",
      // `title` is NOT NULL on the table; PostgREST's generated type says
      // string|null, and derivedOppName wants the column's real shape.
      oppName: derivedOppName({ ...o, title: o.title ?? "" }, a?.company_name ?? null),
      status: STATUS_LABEL[o.sub_status] ?? o.sub_status,
      workOrderNumber: o.ppp_job_number,
      phone: a?.phone ?? null,
      chargesCents: m.t,
      paidCents: m.p,
      balanceCents: m.b,
      agingDays: done ? Math.max(0, Math.round((today - new Date(`${String(done).slice(0, 10)}T12:00:00Z`).getTime()) / 86_400_000)) : null,
    };
  });
}

export const BALANCE_OWED_SPEC: ReportSpec<BalanceOwedRow> = {
  title: "Balance Owed",
  sourceLabel: "Opportunities with Work Orders",
  blurb: "Jobs where the work is finished or on hold and the money is not in. The same records Tomco runs in Salesforce, to the cent.",
  totals: [
    { label: "Total customer charges", value: (rows) => rows.reduce((n, r) => n + r.chargesCents, 0) },
    { label: "Total payments in", value: (rows) => rows.reduce((n, r) => n + r.paidCents, 0) },
    { label: "Total balance owed", value: (rows) => rows.reduce((n, r) => n + r.balanceCents, 0) },
    {
      label: "Final balance aging",
      kind: "number",
      value: (rows) => rows.reduce((n, r) => n + (r.agingDays ?? 0), 0),
    },
  ],
  groupings: [
    // Mary's view first: she chases by GC.
    [
      { key: "account", label: "Account name", of: (r) => r.accountName },
      { key: "status", label: "Status", of: (r) => r.status },
    ],
    // Brendan's view: status is the thing he sorts his day by.
    [{ key: "status", label: "Status", of: (r) => r.status }],
    [{ key: "account", label: "Account name", of: (r) => r.accountName }],
  ],
  columns: [
    { key: "opp", label: "Opportunity name", text: (r) => r.oppName, href: (r) => `/commercial/opportunities/${r.oppId}` },
    { key: "wo", label: "Work order", text: (r) => r.workOrderNumber, secondary: true },
    { key: "charges", label: "Total customer charges", kind: "money", amount: (r) => r.chargesCents },
    { key: "paid", label: "Total payments in", kind: "money", amount: (r) => r.paidCents },
    { key: "balance", label: "Balance owed", kind: "money", amount: (r) => r.balanceCents },
    { key: "phone", label: "Phone", text: (r) => r.phone, secondary: true },
    { key: "aging", label: "Aging", text: (r) => (r.agingDays === null ? null : `${r.agingDays}d`), secondary: true },
  ],
};
