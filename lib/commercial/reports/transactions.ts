import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { etDateOf } from "@/lib/date-et";

/**
 * TRANSACTIONS — the money that actually moved, by month.
 *
 * Karan, 2026-08-19, with Alex's Salesforce folder: thirteen reports Katie
 * built, and the one Alex opens is *"Tomco Payments In by Month"* — a Work
 * Orders with Transactions report, grouped by month, subtotalled, with a record
 * count and a grand total at the top.
 *
 * That report is a LEDGER, and it is the thing this platform did not have.
 * Cash flow charts monthly totals; receivables lists what is owed; job costs
 * roll up per deal. None of them answer "show me every payment that came in,
 * newest month first, and let me tick the ones that cleared" — which is how a
 * bookkeeper actually closes a month.
 *
 * Two departures from his report, both because the platform can say more:
 *
 *  1. It carries money OUT as well as in. His folder splits these across
 *     "Payments In by Month", "Purchases by Month by Vendor" and "Labor
 *     Payments Out This Week"; one ledger with a direction filter is the same
 *     information without three round trips, and it makes NET per month
 *     possible — which none of his reports can show.
 *
 *  2. Labour is NOT in it. His "Labor Payments Out" is a transaction record;
 *     here, crew labour is COMPUTED (approved hours × cost rate) and no payment
 *     row exists. Listing a derived figure in a ledger of real transactions
 *     would be inventing money movement, so it is excluded and said out loud
 *     rather than quietly folded in. Job costs is where that number lives.
 */

export type TxnDirection = "in" | "out";

export type TxnRow = {
  id: string;
  direction: TxnDirection;
  /** ET calendar date the money moved. */
  dateYmd: string;
  dateIso: string;
  /** Alex's "Name" column — the job, or the vendor on a purchase. */
  name: string;
  /** His "Record Type" — Payment In / Materials / Subcontractor / … */
  recordType: string;
  amountCents: number;
  /** His "Reference Id" — cheque number, wire confirmation, memo. */
  reference: string | null;
  /** Payments in only: when it cleared. Null = received, not yet deposited. */
  depositedAtIso: string | null;
  /** Only a payment IN can be deposited; a purchase has nothing to reconcile. */
  depositable: boolean;
  accountId: string | null;
  accountName: string | null;
  opportunityId: string | null;
  /** Where the row lives, so a figure is never a dead end. */
  href: string | null;
};

export type TxnMonth = {
  /** `YYYY-MM`, for sorting. */
  key: string;
  /** "February 2026", the way his report groups. */
  label: string;
  rows: TxnRow[];
  inCents: number;
  outCents: number;
  /** In − out. The number his three separate reports can't produce. */
  netCents: number;
};

export type TransactionsReport = {
  months: TxnMonth[];
  /** His "Total Records". */
  rowCount: number;
  /** His "Total Amount", over whatever is shown. */
  totalCents: number;
  inCents: number;
  outCents: number;
  netCents: number;
  /** Received but not yet deposited — the money sitting in the office. */
  undepositedCents: number;
  undepositedCount: number;
  /** Every GC / vendor in the UNFILTERED set, for the picker. */
  partyOptions: { id: string; name: string }[];
  filtered: boolean;
  generatedAt: string;
};

export type TxnFilters = {
  fromYmd?: string;
  toYmd?: string;
  direction?: TxnDirection;
  /** An account id (money in) or a vendor name (money out). */
  party?: string;
  /** Only payments that haven't cleared. */
  undepositedOnly?: boolean;
};

const MONTH_LABEL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-02" → "February 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_LABEL[(m || 1) - 1]} ${y}`;
}

const CATEGORY_LABEL: Record<string, string> = {
  materials: "Materials",
  subcontractor: "Subcontractor",
  sub_labor: "Sub labor",
  equipment: "Equipment",
  permit: "Permit",
  other: "Other",
};

/**
 * Group, subtotal and total — his report's whole structure.
 *
 * Pure, so the grouping and the money can be tested without a database. The
 * page, the CSV and any future email all render from this one shape, which is
 * what stops the export from ever disagreeing with the screen.
 */
export function summarizeTransactions(
  allRows: TxnRow[],
  filters: TxnFilters = {},
  nowMs = Date.now()
): TransactionsReport {
  const { fromYmd, toYmd, direction, party, undepositedOnly } = filters;
  const filtered = !!(fromYmd || toYmd || direction || party || undepositedOnly);

  const rows = allRows.filter((r) => {
    if (direction && r.direction !== direction) return false;
    if (fromYmd && r.dateYmd < fromYmd) return false;
    if (toYmd && r.dateYmd > toYmd) return false;
    // Match the party the ROW is about, which differs by direction: a payment
    // is from a GC, a purchase is to a vendor. Matching a purchase on its
    // account id too would mean picking "Acme GC" also pulled in every vendor
    // invoice charged to Acme's jobs — defensible, but not what the option
    // says, and the picker labels a GC and a vendor identically.
    if (party) {
      const matches = r.direction === "in" ? r.accountId === party : r.name === party;
      if (!matches) return false;
    }
    // Only a payment IN can be undeposited — a purchase has nothing to clear,
    // so it must not survive this filter just because its field is null.
    if (undepositedOnly && (!r.depositable || r.depositedAtIso)) return false;
    return true;
  });

  const byMonth = new Map<string, TxnMonth>();
  for (const r of rows) {
    const key = r.dateYmd.slice(0, 7);
    let m = byMonth.get(key);
    if (!m) {
      m = { key, label: monthLabel(key), rows: [], inCents: 0, outCents: 0, netCents: 0 };
      byMonth.set(key, m);
    }
    m.rows.push(r);
    if (r.direction === "in") m.inCents += r.amountCents;
    else m.outCents += r.amountCents;
    m.netCents = m.inCents - m.outCents;
  }

  // Newest month first — a bookkeeper closing a month wants this one at the
  // top, not after four years of history. Rows inside stay oldest-first, the
  // way a statement reads.
  const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const m of months) {
    m.rows.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.name.localeCompare(b.name));
  }

  const inCents = rows.filter((r) => r.direction === "in").reduce((n, r) => n + r.amountCents, 0);
  const outCents = rows.filter((r) => r.direction === "out").reduce((n, r) => n + r.amountCents, 0);
  // Undeposited is computed over the SHOWN rows so it agrees with the list, and
  // only over payments in, because nothing else can be deposited.
  const undeposited = rows.filter((r) => r.depositable && !r.depositedAtIso);

  // The picker offers every party in the whole set, not just the filtered one —
  // otherwise picking one hides the rest and you can't switch.
  const partyOptions = [
    ...new Map(
      allRows
        .map((r) =>
          r.direction === "in"
            ? ([r.accountId ?? "", r.accountName ?? "—"] as const)
            : ([r.name, r.name] as const)
        )
        .filter(([id]) => !!id)
    ).entries(),
  ]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    months,
    rowCount: rows.length,
    // His "Total Amount" is the sum of the column. With both directions shown
    // that would add money in to money out, which is not a number — so it is
    // the NET when the view is mixed, and the plain total when it isn't.
    totalCents: direction === "out" ? outCents : direction === "in" ? inCents : inCents - outCents,
    inCents,
    outCents,
    netCents: inCents - outCents,
    undepositedCents: undeposited.reduce((n, r) => n + r.amountCents, 0),
    undepositedCount: undeposited.length,
    partyOptions,
    filtered,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/** Load every real money movement: payments received and purchases paid out. */
export async function getTransactionsReport(
  filters: TxnFilters = {},
  nowMs = Date.now()
): Promise<TransactionsReport> {
  const sb = commercialDb();

  const opps = await listCommercialOpportunities({ includeArchived: true });
  const oppById = new Map(opps.map((o) => [o.id, o] as const));
  const acctIds = [...new Set(opps.map((o) => o.account_id))];
  const nameById = new Map<string, string>();
  if (acctIds.length > 0) {
    const { data } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", acctIds);
    for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
      nameById.set(a.id, a.company_name ?? "—");
    }
  }

  const rows: TxnRow[] = [];

  // ── Money in: invoice payments ──────────────────────────────────────────
  const payments = await paginateAll<{
    id: string;
    invoice_id: string;
    amount_cents: number;
    paid_at: string;
    method: string | null;
    reference: string | null;
    deposited_at: string | null;
  }>(() =>
    sb
      .from("commercial_invoice_payments")
      .select("id, invoice_id, amount_cents, paid_at, method, reference, deposited_at")
      .order("paid_at", { ascending: true })
      .order("id", { ascending: true })
  );

  if (payments.length > 0) {
    const invIds = [...new Set(payments.map((p) => p.invoice_id))];
    const { data: invRows } = await sb
      .from("commercial_invoices")
      .select("id, invoice_number, opportunity_id, account_id, deleted_at")
      .in("id", invIds);
    const invById = new Map(
      ((invRows ?? []) as {
        id: string;
        invoice_number: string;
        opportunity_id: string;
        account_id: string;
        deleted_at: string | null;
      }[]).map((i) => [i.id, i] as const)
    );
    for (const p of payments) {
      const inv = invById.get(p.invoice_id);
      // A payment on a deleted invoice is gone from the app; it must be gone
      // from the ledger too, or the month never ties out against the screen.
      if (!inv || inv.deleted_at) continue;
      const opp = oppById.get(inv.opportunity_id);
      const accountName = nameById.get(inv.account_id) ?? null;
      const ymd = etDateOf(p.paid_at);
      if (!ymd) continue;
      rows.push({
        id: `pay:${p.id}`,
        direction: "in",
        dateYmd: ymd,
        dateIso: p.paid_at,
        name: opp ? derivedOppName(opp, accountName) : inv.invoice_number,
        recordType: "Payment In",
        amountCents: p.amount_cents,
        // His "Reference Id" column. Falls back to the invoice number, which is
        // what somebody writes on the cheque stub when there's nothing else.
        reference: p.reference?.trim() || inv.invoice_number,
        depositedAtIso: p.deposited_at,
        depositable: true,
        accountId: inv.account_id,
        accountName,
        opportunityId: inv.opportunity_id,
        href: `/commercial/invoices/${inv.id}`,
      });
    }
  }

  // ── Money out: project purchases ────────────────────────────────────────
  const purchases = await paginateAll<{
    id: string;
    opportunity_id: string | null;
    account_id: string | null;
    category: string | null;
    vendor: string | null;
    amount_cents: number | null;
    purchased_at: string | null;
    description: string | null;
  }>(() =>
    sb
      .from("commercial_project_purchases")
      .select("id, opportunity_id, account_id, category, vendor, amount_cents, purchased_at, description")
      .is("deleted_at", null)
      .order("purchased_at", { ascending: true })
      .order("id", { ascending: true })
  );

  for (const p of purchases) {
    const ymd = p.purchased_at ? etDateOf(p.purchased_at) : null;
    if (!ymd || !p.amount_cents) continue;
    const opp = p.opportunity_id ? oppById.get(p.opportunity_id) : null;
    const accountId = p.account_id ?? opp?.account_id ?? null;
    const accountName = accountId ? nameById.get(accountId) ?? null : null;
    rows.push({
      id: `buy:${p.id}`,
      direction: "out",
      dateYmd: ymd,
      dateIso: p.purchased_at!,
      // Vendor first: on the money-out side that IS the name Alex reads, and
      // his own report is "Purchases by Month by VENDOR".
      name: p.vendor?.trim() || "Unnamed vendor",
      recordType: CATEGORY_LABEL[p.category ?? "other"] ?? "Purchase",
      amountCents: p.amount_cents,
      reference: p.description?.trim() || (opp ? derivedOppName(opp, accountName) : null),
      depositedAtIso: null,
      depositable: false,
      accountId,
      accountName,
      opportunityId: p.opportunity_id,
      href: p.opportunity_id
        ? `/commercial/opportunities/${p.opportunity_id}?tab=transactions`
        : null,
    });
  }

  return summarizeTransactions(rows, filters, nowMs);
}

/** Tick (or untick) a payment as deposited. */
export async function setPaymentDeposited(
  paymentId: string,
  deposited: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_payments")
    .update({ deposited_at: deposited ? new Date().toISOString() : null })
    .eq("id", paymentId);
  return error
    ? { ok: false, error: "Couldn't update that payment. Please try again." }
    : { ok: true };
}
