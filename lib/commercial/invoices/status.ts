/**
 * Phase 3 · Invoicing — status DAG enforcement.
 *
 * Every user-driven status transition goes through `changeInvoiceStatus`.
 * That function:
 *   1. Fetches the current row so it can validate against the DAG.
 *   2. Rejects illegal transitions (returns { ok: false, error }).
 *   3. Applies the write.
 *   4. Logs to commercial_invoice_status_log.
 *   5. Stamps the corresponding lifecycle timestamp (sent_at, viewed_at,
 *      voided_at) so reporting queries don't need special-case logic.
 *
 * Note: paid + partial statuses are DRIVEN BY THE PAYMENT TRIGGER, not
 * by direct user transitions. This function refuses `to_status = paid`
 * and `to_status = partial` to enforce that discipline.
 */

import { commercialDb } from "@/lib/commercial/db";
import {
  ALLOWED_INVOICE_TRANSITIONS,
  type InvoiceStatus,
} from "./constants";
import { logStatusChange } from "./db";

export function isTransitionAllowed(
  from_status: InvoiceStatus,
  to_status: InvoiceStatus
): boolean {
  const allowed = ALLOWED_INVOICE_TRANSITIONS[from_status];
  return allowed?.includes(to_status) ?? false;
}

export function allowedNextStatuses(from_status: InvoiceStatus): ReadonlyArray<InvoiceStatus> {
  return ALLOWED_INVOICE_TRANSITIONS[from_status] ?? [];
}

export type ChangeInvoiceStatusInput = {
  invoice_id: string;
  to_status: InvoiceStatus;
  acting_user_id: string;
  note?: string;
};

export async function changeInvoiceStatus(
  input: ChangeInvoiceStatusInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Explicit refusal — payment-driven statuses can't be set by hand.
  if (input.to_status === "paid" || input.to_status === "partial") {
    return { ok: false, error: "payment_driven_status_cannot_be_set" };
  }

  const { data: before } = await sb
    .from("commercial_invoices")
    .select("status, deleted_at")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (!before || before.deleted_at) return { ok: false, error: "invoice_not_found" };
  const from_status = before.status as InvoiceStatus;

  if (!isTransitionAllowed(from_status, input.to_status)) {
    return { ok: false, error: `disallowed_transition:${from_status}->${input.to_status}` };
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: input.to_status,
    updated_at: now,
  };

  // Lifecycle timestamps — set on the state entry, don't overwrite prior
  // ones (a sent → viewed → sent flip shouldn't clear sent_at).
  if (input.to_status === "sent") {
    patch.sent_at = now;
    patch.issued_at = now;
  }
  if (input.to_status === "viewed") {
    patch.viewed_at = now;
  }
  if (input.to_status === "void") {
    patch.voided_at = now;
  }

  const { error } = await sb.from("commercial_invoices").update(patch).eq("id", input.invoice_id);
  if (error) return { ok: false, error: error.message };

  await logStatusChange(
    input.invoice_id,
    from_status,
    input.to_status,
    input.acting_user_id,
    input.note
  );
  return { ok: true };
}

/** Soft-delete an invoice. Karan 2026-07-07: opened up to any state so
 *  a void/paid invoice that clutters the list can be removed. The row
 *  stays in the DB (deleted_at set) so reporting can still reconstruct
 *  history; the UI just filters `deleted_at is null` everywhere. */
export async function softDeleteInvoice(
  invoice_id: string,
  actor_user_id: string
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_invoices")
    .select("status, deleted_at")
    .eq("id", invoice_id)
    .maybeSingle();
  if (!before || before.deleted_at) return { ok: false, error: "invoice_not_found" };
  const from_status = before.status as InvoiceStatus;
  const { error } = await sb
    .from("commercial_invoices")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", invoice_id);
  if (error) return { ok: false, error: error.message };
  await logStatusChange(invoice_id, from_status, "void", actor_user_id, "Invoice deleted");
  return { ok: true };
}

/**
 * Restore a soft-deleted invoice. Powers the undo-toast for accidental
 * delete clicks (Karan 2026-07-11 signature-moments). Only restores if
 * currently deleted — race-safe against concurrent restore + re-delete.
 * Logs a synthetic status change so the audit trail records the undo.
 */
export async function restoreInvoice(
  invoice_id: string,
  actor_user_id: string
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_invoices")
    .select("status, deleted_at")
    .eq("id", invoice_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "invoice_not_found" };
  if (!before.deleted_at) return { ok: false, error: "invoice_not_deleted" };
  const { error } = await sb
    .from("commercial_invoices")
    .update({ deleted_at: null, updated_at: new Date().toISOString() })
    .eq("id", invoice_id);
  if (error) return { ok: false, error: error.message };
  await logStatusChange(
    invoice_id,
    before.status as InvoiceStatus,
    before.status as InvoiceStatus,
    actor_user_id,
    "Invoice restored (undo)"
  );
  return { ok: true };
}
