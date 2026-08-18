import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus } from "@/lib/commercial/invoices/constants";

/**
 * AR Aging report (R4) — every OPEN invoice's balance bucketed by how far past
 * due it is, grouped by customer. "Open" = issued (not draft/void) with a
 * positive balance. Aging buckets are the standard Current / 1-30 / 31-60 /
 * 61-90 / 90+ days past the due date (no due date → Current).
 */

export type ArAgingBuckets = {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
};

export type ArAgingRow = ArAgingBuckets & {
  accountId: string;
  accountName: string;
  invoiceCount: number;
  /** Oldest days-past-due in this customer's open book (for a severity hint). */
  oldestDays: number;
};

export type ArAging = {
  rows: ArAgingRow[]; // one per customer, sorted by total owed desc
  totals: ArAgingBuckets;
  invoiceCount: number;
  customerCount: number;
  /** Balance-weighted average age of the open book, in days past due — a DSO-like
   *  health number (Σ balance × max(0, daysPastDue) ÷ Σ balance). */
  weightedAvgAgeDays: number;
};

function emptyBuckets(): ArAgingBuckets {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
}

/** Whole days from the due date to today (ET-agnostic day granularity). >0 = past due. */
export function daysPastDue(dueAt: string | null, nowMs: number): number {
  if (!dueAt) return 0; // no due date → not yet past due → Current
  const due = dueAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return 0;
  // Diff whole ET calendar days — anchoring on UTC midnight flipped the bucket a
  // day early during ET evenings (UTC-day rollover is ~7-8pm ET).
  const nowEt = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [dy, dm, dd] = due.split("-").map(Number);
  const [ny, nm, nd] = nowEt.split("-").map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / 86_400_000);
}

function bucketOf(days: number): keyof Omit<ArAgingBuckets, "total"> {
  if (days <= 0) return "current";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

export async function getArAging(nowMs = Date.now()): Promise<ArAging> {
  const invoices = await listCommercialInvoices({});
  // Orphan guard, matching the dashboard "Owed to us" tile that links here: an
  // invoice whose deal was soft-deleted (or whose account was, which cascades to
  // the deal) is gone from the app and must be gone from the collections book.
  // ARCHIVED deals stay — archiving is a tidy-up, not a write-off, and their
  // debt is still owed. `includeArchived` is what makes the two agree; the tile
  // read $0 against this report's $40,000 before either side had a guard.
  const { listCommercialOpportunities } = await import("@/lib/commercial/opportunities/db");
  const realOppIds = new Set(
    (await listCommercialOpportunities({ includeArchived: true })).map((o) => o.id)
  );
  const open = invoices.filter((i) => {
    if (i.opportunity_id != null && !realOppIds.has(i.opportunity_id)) return false;
    const s = deriveInvoiceStatus(i);
    return s !== "draft" && s !== "void" && i.balance_cents > 0;
  });

  // Resolve customer names in one query.
  const acctIds = [...new Set(open.map((i) => i.account_id))];
  const nameById = new Map<string, string>();
  if (acctIds.length > 0) {
    const sb = commercialDb();
    const { data } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", acctIds);
    for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
      nameById.set(a.id, a.company_name ?? "—");
    }
  }

  // AIA payment applications are receivables with no invoice row (2026-08-17).
  // The report is the collections book; a job billed only through G702/G703 was
  // simply absent from it. Amount = earned-less-retainage minus collected, so
  // retainage never ages — see aiaBilledCollectedFrom for why that matters.
  //
  // Batched. The first cut looped `aiaBillingRollup` per opportunity, and that
  // helper fans out to several queries each — so this report issued roughly
  // five sequential round-trips per live opportunity before rendering. Two
  // queries now, whatever the pipeline size.
  const aiaRows: { accountId: string; balance: number; days: number }[] = [];
  {
    const { aiaBillingRollupBulk } = await import("@/lib/commercial/aia/db");
    const { DEFAULT_DUE_DAYS } = await import("@/lib/commercial/invoices/constants");
    const liveOpps = await listCommercialOpportunities({ includeArchived: true });
    const rollups = await aiaBillingRollupBulk(liveOpps.map((o) => o.id));
    const accountByOpp = new Map(liveOpps.map((o) => [o.id, o.account_id] as const));
    for (const [oppId, roll] of rollups) {
      if (roll.dueNowCents <= 0) continue;
      const accountId = accountByOpp.get(oppId);
      if (!accountId) continue;
      const issuedAt =
        roll.latestIssuedFrozenAt ??
        (roll.latestIssuedPeriodTo ? `${roll.latestIssuedPeriodTo}T16:00:00Z` : null);
      const dueAt = issuedAt
        ? new Date(new Date(issuedAt).getTime() + DEFAULT_DUE_DAYS * 86_400_000).toISOString()
        : null;
      aiaRows.push({
        accountId,
        balance: roll.dueNowCents,
        days: dueAt ? daysPastDue(dueAt, nowMs) : 0,
      });
      if (!acctIds.includes(accountId)) acctIds.push(accountId);
    }
    // Names for any account that ONLY has AIA billing — it wasn't in the
    // invoice-derived id list, so it had no name resolved above.
    const missing = acctIds.filter((id) => !nameById.has(id));
    if (missing.length > 0) {
      const sb2 = commercialDb();
      const { data } = await sb2
        .from("commercial_accounts")
        .select("id, company_name")
        .in("id", missing);
      for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
        nameById.set(a.id, a.company_name ?? "—");
      }
    }
  }

  const byAccount = new Map<string, ArAgingRow>();
  const totals = emptyBuckets();
  let ageWeightSum = 0; // Σ balance × max(0, daysPastDue)

  for (const inv of open) {
    const days = daysPastDue(inv.due_at, nowMs);
    const bucket = bucketOf(days);
    const bal = inv.balance_cents;
    ageWeightSum += bal * Math.max(0, days);

    let row = byAccount.get(inv.account_id);
    if (!row) {
      row = {
        accountId: inv.account_id,
        accountName: nameById.get(inv.account_id) ?? "—",
        invoiceCount: 0,
        oldestDays: 0,
        ...emptyBuckets(),
      };
      byAccount.set(inv.account_id, row);
    }
    row[bucket] += bal;
    row.total += bal;
    row.invoiceCount += 1;
    row.oldestDays = Math.max(row.oldestDays, days);

    totals[bucket] += bal;
    totals.total += bal;
  }

  // Same aggregation for the AIA applications collected above — one row per GC
  // whether the money came from an invoice or a payment application.
  for (const a of aiaRows) {
    const bucket = bucketOf(a.days);
    ageWeightSum += a.balance * Math.max(0, a.days);
    let row = byAccount.get(a.accountId);
    if (!row) {
      row = {
        accountId: a.accountId,
        accountName: nameById.get(a.accountId) ?? "—",
        invoiceCount: 0,
        oldestDays: 0,
        ...emptyBuckets(),
      };
      byAccount.set(a.accountId, row);
    }
    row[bucket] += a.balance;
    row.total += a.balance;
    row.invoiceCount += 1;
    row.oldestDays = Math.max(row.oldestDays, a.days);
    totals[bucket] += a.balance;
    totals.total += a.balance;
  }

  const rows = [...byAccount.values()].sort((a, b) => b.total - a.total);
  return {
    rows,
    totals,
    invoiceCount: open.length + aiaRows.length,
    customerCount: rows.length,
    weightedAvgAgeDays: totals.total > 0 ? Math.round(ageWeightSum / totals.total) : 0,
  };
}
