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
    .select("status, deleted_at, issued_at")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (!before || before.deleted_at) return { ok: false, error: "invoice_not_found" };
  const from_status = before.status as InvoiceStatus;
  const priorIssuedAt = (before as { issued_at: string | null }).issued_at;

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
  // Audit fix: issued_at is the FIRST send date (source of truth for
  // AR aging + audit trail). Only stamp it if NULL; don't clobber the
  // original on a re-send. sent_at can re-stamp (most-recent send).
  if (input.to_status === "sent") {
    patch.sent_at = now;
    if (!priorIssuedAt) patch.issued_at = now;
  }
  if (input.to_status === "viewed") {
    patch.viewed_at = now;
  }
  if (input.to_status === "void") {
    patch.voided_at = now;
  }

  // 2026-07-29 re-audit fix (TOCTOU): the DAG was validated against the READ
  // status, but the write didn't re-assert it. Two concurrent flips from the
  // same state (e.g. sent→void and sent→viewed) both passed and both wrote,
  // so a row could land status='viewed' WITH voided_at set — making a voided
  // invoice editable/payable again. Compare-and-swap on the prior status +
  // still-not-deleted so only one flip wins.
  const { data: updated, error } = await sb
    .from("commercial_invoices")
    .update(patch)
    .eq("id", input.invoice_id)
    .eq("status", from_status)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "invoice_status_changed_concurrently" };

  if (input.to_status === "void") {
    await releaseTickedChangeOrders(input.invoice_id); // D1: re-open any billed COs
  }
  await logStatusChange(
    input.invoice_id,
    from_status,
    input.to_status,
    input.acting_user_id,
    input.note
  );
  return { ok: true };
}

/**
 * Phase 1A (audit D1): when an invoice dies (void or soft-delete), FREE any
 * change orders billed on it so they can be re-billed cleanly. Without this the
 * CO's line/milestone tag survives, the partial UNIQUE index (mig 093) holds the
 * slot, and re-ticking the CO fails forever with no UI escape. We hard-delete
 * the CO lines (the invoice is dead, and a deduct line can't have its tag nulled
 * without violating the >=0 CHECK), soft-delete the CO milestones (frees the
 * `WHERE deleted_at IS NULL` slot), and null the COs' invoiced_invoice_id — but
 * ONLY for COs still pointing at THIS invoice (never stomps another claim).
 */
async function releaseTickedChangeOrders(invoiceId: string): Promise<void> {
  const sb = commercialDb();
  const [{ data: lines }, { data: ms }] = await Promise.all([
    sb.from("commercial_invoice_line_items").select("change_order_id").eq("invoice_id", invoiceId).not("change_order_id", "is", null),
    sb.from("commercial_invoice_milestones").select("change_order_id").eq("invoice_id", invoiceId).not("change_order_id", "is", null).is("deleted_at", null),
  ]);
  const coIds = new Set<string>();
  for (const l of (lines ?? []) as { change_order_id: string | null }[]) if (l.change_order_id) coIds.add(l.change_order_id);
  for (const m of (ms ?? []) as { change_order_id: string | null }[]) if (m.change_order_id) coIds.add(m.change_order_id);
  if (coIds.size === 0) return;
  await sb.from("commercial_invoice_line_items").delete().eq("invoice_id", invoiceId).not("change_order_id", "is", null);
  await sb.from("commercial_invoice_milestones").update({ deleted_at: new Date().toISOString() }).eq("invoice_id", invoiceId).not("change_order_id", "is", null).is("deleted_at", null);
  await sb.from("commercial_change_orders").update({ invoiced_invoice_id: null, updated_at: new Date().toISOString() }).in("id", [...coIds]).eq("invoiced_invoice_id", invoiceId);
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
  // CAS on deleted_at IS NULL so two concurrent deletes don't both log.
  const { data: deleted, error } = await sb
    .from("commercial_invoices")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", invoice_id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!deleted) return { ok: false, error: "invoice_not_found" };
  await releaseTickedChangeOrders(invoice_id); // D1: re-open any billed COs
  // Phase 2 (audit H1): per-payment lien waivers + invoice attachments are
  // deliberately RETAINED on soft-delete — each is parented to the live
  // opportunity (a valid deal document, never an orphan) and this keeps
  // restoreInvoice lossless. The only payment-removal path (removePayment)
  // retires its own waiver. If a HARD invoice delete is ever added, it MUST
  // iterate payments to retire lien_waiver_document_id + retire attachment docs
  // (the payments FK is ON DELETE CASCADE and would bypass that teardown).
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
  // CAS on deleted_at IS NOT NULL so the "race-safe" claim is actually true.
  const { data: restored, error } = await sb
    .from("commercial_invoices")
    .update({ deleted_at: null, updated_at: new Date().toISOString() })
    .eq("id", invoice_id)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!restored) return { ok: false, error: "invoice_not_deleted" };
  await logStatusChange(
    invoice_id,
    before.status as InvoiceStatus,
    before.status as InvoiceStatus,
    actor_user_id,
    "Invoice restored (undo)"
  );
  return { ok: true };
}
