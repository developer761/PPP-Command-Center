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

/** Soft-delete an invoice. Only drafts can be deleted; sent invoices
 *  must be voided instead (paper trail). */
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
  if (before.status !== "draft") {
    return { ok: false, error: "only_drafts_can_be_deleted_use_void_instead" };
  }
  const { error } = await sb
    .from("commercial_invoices")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", invoice_id);
  if (error) return { ok: false, error: error.message };
  await logStatusChange(invoice_id, "draft", "void", actor_user_id, "Draft deleted");
  return { ok: true };
}
