import "server-only";

/**
 * Per-PAYMENT lien waiver (Phase 2). A partial waiver arrives per progress
 * payment: the GC sends the signed file → we STORE it against that payment
 * (migration 094 `lien_waiver_document_id`). Mirrors the invoice-level (089) +
 * milestone-level (090) waiver spine exactly: the file becomes a
 * commercial_documents row (parent=opportunity, category=lien_waiver) so it lands
 * in the deal Documents tab, then the doc id is linked onto the payment. We STORE
 * signed waivers, never generate them.
 */

import { commercialDb } from "@/lib/commercial/db";
import { uploadDocument, softDeleteDocument, getDocumentsByIds, type CommercialDocument } from "@/lib/commercial/documents/db";
import type { CommercialInvoicePayment } from "./db";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchPaymentScope(paymentId: string, opts?: { forWrite?: boolean }): Promise<{
  opportunity_id: string;
  invoice_number: string;
  reference: string | null;
  paid_at: string;
  lien_waiver_document_id: string | null;
} | null> {
  const sb = commercialDb();
  const { data: pay } = await sb
    .from("commercial_invoice_payments")
    .select("invoice_id, reference, paid_at, lien_waiver_document_id")
    .eq("id", paymentId)
    .maybeSingle();
  if (!pay) return null;
  const p = pay as { invoice_id: string; reference: string | null; paid_at: string; lien_waiver_document_id: string | null };
  const { data: inv } = await sb
    .from("commercial_invoices")
    .select("opportunity_id, invoice_number, status")
    .eq("id", p.invoice_id)
    .maybeSingle();
  if (!inv) return null;
  const i = inv as { opportunity_id: string; invoice_number: string; status: string };
  // Void invoice = dead; block filing a new partial waiver on its payment
  // server-side (mirrors the UI's readOnly-on-void). Reads still resolve.
  if (opts?.forWrite && i.status === "void") return null;
  return {
    opportunity_id: i.opportunity_id,
    invoice_number: i.invoice_number,
    reference: p.reference,
    paid_at: p.paid_at,
    lien_waiver_document_id: p.lien_waiver_document_id,
  };
}

function waiverNote(scope: { invoice_number: string; reference: string | null; paid_at: string }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(scope.paid_at);
  const date = m ? `${m[2]}/${m[3]}/${m[1]}` : "";
  const ref = scope.reference ? `#${scope.reference}` : date || "payment";
  return `Lien waiver — ${scope.invoice_number} — payment ${ref}`;
}

export async function attachPaymentLienWaiver(input: {
  paymentId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const scope = await fetchPaymentScope(input.paymentId, { forWrite: true });
  if (!scope) return { ok: false, error: "This payment can't take a waiver (its invoice may be voided or removed)." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: scope.opportunity_id,
    category: "lien_waiver",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: waiverNote(scope),
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_payments")
    .update({ lien_waiver_document_id: uploaded.document.id })
    .eq("id", input.paymentId);
  if (error) {
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }
  // Replace semantics: retire the prior waiver on this payment.
  if (scope.lien_waiver_document_id && scope.lien_waiver_document_id !== uploaded.document.id) {
    await softDeleteDocument(scope.lien_waiver_document_id, input.actorUserId).catch(() => {});
  }
  return { ok: true, value: uploaded.document };
}

export async function removePaymentLienWaiver(paymentId: string, actorUserId: string): Promise<Result<null>> {
  const scope = await fetchPaymentScope(paymentId);
  if (!scope) return { ok: false, error: "Payment not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_payments")
    .update({ lien_waiver_document_id: null })
    .eq("id", paymentId);
  if (error) return { ok: false, error: error.message };
  if (scope.lien_waiver_document_id) {
    await softDeleteDocument(scope.lien_waiver_document_id, actorUserId).catch(() => {});
  }
  return { ok: true, value: null };
}

/** Batch resolve per-payment waiver docs in ONE query (invoice detail). */
export async function getPaymentLienWaivers(
  payments: CommercialInvoicePayment[]
): Promise<Map<string, CommercialDocument | null>> {
  const docIds = payments.map((p) => p.lien_waiver_document_id).filter((x): x is string => !!x);
  const docs = await getDocumentsByIds(docIds);
  const out = new Map<string, CommercialDocument | null>();
  for (const p of payments) {
    out.set(p.id, p.lien_waiver_document_id ? docs.get(p.lien_waiver_document_id) ?? null : null);
  }
  return out;
}
