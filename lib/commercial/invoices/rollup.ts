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
import { deriveInvoiceStatus, type InvoiceStatus } from "./constants";

export type AccountInvoiceRollup = {
  invoiced_cents: number;
  paid_cents: number;
  balance_cents: number;
  invoice_count: number;
  overdue_count: number;
  /** DRAFT invoices — not yet billed. Shown separately, never in Invoiced. */
  drafted_cents: number;
  draft_count: number;
};

const ZERO: AccountInvoiceRollup = {
  invoiced_cents: 0,
  paid_cents: 0,
  balance_cents: 0,
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
  const issued = nonVoid.filter((r) => r.status !== "draft");
  const drafts = nonVoid.filter((r) => r.status === "draft");
  const invoiced = issued.reduce((s, r) => s + r.total_cents, 0);
  const paid = issued.reduce((s, r) => s + r.paid_cents, 0);
  const balance = invoiced - paid;
  const drafted = drafts.reduce((s, r) => s + r.total_cents, 0);
  const overdue = issued.filter((r) => deriveInvoiceStatus(r as unknown as { status: InvoiceStatus; due_at: string | null; balance_cents: number }) === "overdue").length;

  return {
    invoiced_cents: invoiced,
    paid_cents: paid,
    balance_cents: balance,
    invoice_count: nonVoid.length,
    overdue_count: overdue,
    drafted_cents: drafted,
    draft_count: drafts.length,
  };
}
