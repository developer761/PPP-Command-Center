/**
 * Phase 3 · Invoicing — per-account roll-up helpers.
 *
 * Karan 2026-07-07 bug fix: the original `commercial_account_invoice_rollup`
 * DB view (migration 042) excluded drafts from Invoiced + Balance totals.
 * A customer with a $9K Sent + $1.2K Draft + $200 Draft opp would see
 * "Invoiced $9K" on Account 360 and get confused. Same mental-model bug
 * we fixed on the opp Invoices tab.
 *
 * Fix: bypass the DB view entirely and compute the rollup in JS from raw
 * invoice rows. Same rule as the opp panel — include every non-void
 * invoice in Invoiced. Balance = Invoiced - Paid. Drafts contribute $0
 * to Paid by definition, so Balance stays accurate.
 *
 * Overdue count uses deriveInvoiceStatus so overdue detection matches
 * the read-side derived status everywhere.
 */

import { commercialDb } from "@/lib/commercial/db";
import { deriveInvoiceStatus, type InvoiceStatus } from "./constants";

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

type InvoiceRow = {
  status: InvoiceStatus;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_at: string | null;
};

export async function getInvoiceRollupForAccount(account_id: string): Promise<AccountInvoiceRollup> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoices")
    .select("status, total_cents, paid_cents, balance_cents, due_at")
    .eq("account_id", account_id)
    .is("deleted_at", null);
  if (error) {
    console.warn("[commercial/invoices/rollup] fetch failed:", error.message);
    return ZERO;
  }
  const rows = (data ?? []) as InvoiceRow[];
  if (rows.length === 0) return ZERO;

  const nonVoid = rows.filter((r) => r.status !== "void");
  const invoiced = nonVoid.reduce((s, r) => s + r.total_cents, 0);
  const paid = nonVoid.reduce((s, r) => s + r.paid_cents, 0);
  const balance = invoiced - paid;
  const overdue = nonVoid.filter((r) => deriveInvoiceStatus(r as unknown as { status: InvoiceStatus; due_at: string | null; balance_cents: number }) === "overdue").length;

  return {
    invoiced_cents: invoiced,
    paid_cents: paid,
    balance_cents: balance,
    invoice_count: nonVoid.length,
    overdue_count: overdue,
  };
}
