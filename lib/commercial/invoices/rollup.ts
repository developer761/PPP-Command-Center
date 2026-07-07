/**
 * Phase 3 · Invoicing — per-account roll-up helpers.
 *
 * Reads the `commercial_account_invoice_rollup` view (migration 042).
 * Returns zeros if the view isn't populated yet (fresh install before
 * any invoice exists) — the KPI strip renders "—" / "$0" in that case
 * rather than a placeholder.
 */

import { commercialDb } from "@/lib/commercial/db";

export type AccountInvoiceRollup = {
  invoiced_cents: number;
  paid_cents: number;
  balance_cents: number;
  invoice_count: number;
  overdue_count: number;
};

const ZERO: AccountInvoiceRollup = {
  invoiced_cents: 0,
  paid_cents: 0,
  balance_cents: 0,
  invoice_count: 0,
  overdue_count: 0,
};

export async function getInvoiceRollupForAccount(account_id: string): Promise<AccountInvoiceRollup> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_invoice_rollup")
    .select("invoiced_cents, paid_cents, balance_cents, invoice_count, overdue_count")
    .eq("account_id", account_id)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/invoices/rollup] fetch failed:", error.message);
    return ZERO;
  }
  if (!data) return ZERO;
  return {
    invoiced_cents: (data.invoiced_cents as number) ?? 0,
    paid_cents: (data.paid_cents as number) ?? 0,
    balance_cents: (data.balance_cents as number) ?? 0,
    invoice_count: (data.invoice_count as number) ?? 0,
    overdue_count: (data.overdue_count as number) ?? 0,
  };
}
