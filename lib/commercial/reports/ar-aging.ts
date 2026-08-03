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
};

function emptyBuckets(): ArAgingBuckets {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
}

/** Whole days from the due date to today (ET-agnostic day granularity). >0 = past due. */
export function daysPastDue(dueAt: string | null, nowMs: number): number {
  if (!dueAt) return 0; // no due date → not yet past due → Current
  const d = new Date(`${dueAt.slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.floor((nowMs - d) / 86_400_000);
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
  const open = invoices.filter((i) => {
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

  const byAccount = new Map<string, ArAgingRow>();
  const totals = emptyBuckets();

  for (const inv of open) {
    const days = daysPastDue(inv.due_at, nowMs);
    const bucket = bucketOf(days);
    const bal = inv.balance_cents;

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

  const rows = [...byAccount.values()].sort((a, b) => b.total - a.total);
  return {
    rows,
    totals,
    invoiceCount: open.length,
    customerCount: rows.length,
  };
}
