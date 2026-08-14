/**
 * Phase 3 · Invoicing — per-account roll-up helpers.
 *
 * 2026-07-29 financial truth (supersedes the 2026-07-07 "include drafts"
 * choice): "Invoiced" = ISSUED invoices only (sent/viewed/partial/overdue/
 * paid). A DRAFT isn't billed to the GC yet, so it must NOT inflate Invoiced /
 * Balance — otherwise this rollup disagreed with the project card + Projects
 * tab (which are issued-only). Drafts are carried separately as `drafted_cents`
 * + `draft_count` so the UI can still surface "$X in N drafts not yet sent."
 * Balance = Invoiced (issued) − Paid.
 *
 * Overdue count uses deriveInvoiceStatus so overdue detection matches
 * the read-side derived status everywhere.
 */

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { deriveInvoiceStatus, type InvoiceStatus } from "./constants";

export type AccountInvoiceRollup = {
  invoiced_cents: number;
  paid_cents: number;
  /** Net position = Invoiced − Paid (can go negative on an overpayment). Kept
   *  for internal math; the UI shows open_balance_cents / credit_cents so it
   *  ties out with the AR statement (audit F3). */
  balance_cents: number;
  /** TRUE open receivable = Σ max(0, per-invoice balance) over issued invoices —
   *  a credit on one invoice does NOT net away another's real open balance. This
   *  equals the AR statement's total-outstanding by construction. */
  open_balance_cents: number;
  /** Σ max(0, −per-invoice balance) — overpayment credits, surfaced separately
   *  so they never hide a genuine open balance. */
  credit_cents: number;
  invoice_count: number;
  overdue_count: number;
  /** DRAFT invoices — not yet billed. Shown separately, never in Invoiced. */
  drafted_cents: number;
  draft_count: number;
};

/**
 * Split issued-invoice net balances into the TRUE open receivable and the
 * overpayment credit, clamping PER INVOICE. A credit on one invoice must never
 * net away another invoice's real open balance (audit F3) — so this is not
 * `Σ balance`. `openBalance` equals the AR statement's total-outstanding by
 * construction. Pure + exported for unit tests.
 */
export function splitOpenBalance(issuedBalances: number[]): { openBalance: number; credit: number } {
  let openBalance = 0;
  let credit = 0;
  for (const b of issuedBalances) {
    if (b > 0) openBalance += b;
    else if (b < 0) credit += -b;
  }
  return { openBalance, credit };
}

const ZERO: AccountInvoiceRollup = {
  invoiced_cents: 0,
  paid_cents: 0,
  balance_cents: 0,
  open_balance_cents: 0,
  credit_cents: 0,
  invoice_count: 0,
  overdue_count: 0,
  drafted_cents: 0,
  draft_count: 0,
};

type InvoiceRow = {
  status: InvoiceStatus;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_at: string | null;
};

export async function getInvoiceRollupForAccount(account_id: string): Promise<AccountInvoiceRollup> {
  const sb = commercialDb();
  // Paginated — a long-running GC can accumulate well over 1000 invoices, and
  // the bare query silently capped at 1000, understating every Account-360 money
  // tile (invoiced / paid / balance) vs the paginated siblings (audit M5).
  const rows = await paginateAll<InvoiceRow>(() =>
    sb
      .from("commercial_invoices")
      .select("status, total_cents, paid_cents, balance_cents, due_at")
      .eq("account_id", account_id)
      .is("deleted_at", null)
      .order("id")
  );
  if (rows.length === 0) return ZERO;

  const nonVoid = rows.filter((r) => r.status !== "void");
  const issued = nonVoid.filter((r) => r.status !== "draft");
  const drafts = nonVoid.filter((r) => r.status === "draft");
  const invoiced = issued.reduce((s, r) => s + r.total_cents, 0);
  const paid = issued.reduce((s, r) => s + r.paid_cents, 0);
  const balance = invoiced - paid;
  // Per-invoice clamp so an overpaid invoice's credit can't mask another
  // invoice's real open balance (audit F3). open_balance == AR statement total.
  const { openBalance, credit } = splitOpenBalance(issued.map((r) => r.balance_cents));
  const drafted = drafts.reduce((s, r) => s + r.total_cents, 0);
  const overdue = issued.filter((r) => deriveInvoiceStatus(r as unknown as { status: InvoiceStatus; due_at: string | null; balance_cents: number }) === "overdue").length;

  return {
    invoiced_cents: invoiced,
    paid_cents: paid,
    balance_cents: balance,
    open_balance_cents: openBalance,
    credit_cents: credit,
    invoice_count: nonVoid.length,
    overdue_count: overdue,
    drafted_cents: drafted,
    draft_count: drafts.length,
  };
}
