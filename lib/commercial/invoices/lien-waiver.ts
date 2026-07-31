import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { uploadDocument, getDocument, softDeleteDocument } from "@/lib/commercial/documents/db";
import type { CommercialDocument } from "@/lib/commercial/documents/db";

/**
 * Lien waiver ↔ invoice/milestone (2026-08). Every invoice is a milestone and
 * every milestone stores a lien waiver (uploaded, never generated). The waiver
 * is a per-deal document (parent_type=opportunity, category=lien_waiver) so it
 * lands in the deal's Documents tab automatically; `commercial_invoices
 * .lien_waiver_document_id` links the specific waiver to its invoice for the
 * ✓/missing status shown on the milestone.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchInvoiceScope(invoiceId: string): Promise<{ opportunity_id: string; invoice_number: string; lien_waiver_document_id: string | null } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoices")
    .select("opportunity_id, invoice_number, lien_waiver_document_id")
    .eq("id", invoiceId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { opportunity_id: string; invoice_number: string; lien_waiver_document_id: string | null } | null) ?? null;
}

/** The linked lien-waiver document for an invoice, or null. Soft-delete aware. */
export async function getInvoiceLienWaiver(invoiceId: string): Promise<CommercialDocument | null> {
  const inv = await fetchInvoiceScope(invoiceId);
  if (!inv?.lien_waiver_document_id) return null;
  const doc = await getDocument(inv.lien_waiver_document_id);
  // The doc may have been deleted from the Documents tab — treat as unset.
  return doc ?? null;
}

/** Store a lien waiver against an invoice: file → per-deal document (category
 *  lien_waiver) → link to the invoice. Replaces + soft-deletes any prior one. */
export async function attachInvoiceLienWaiver(input: {
  invoiceId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const inv = await fetchInvoiceScope(input.invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: inv.opportunity_id,
    category: "lien_waiver",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Lien waiver — ${inv.invoice_number}`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoices")
    .update({ lien_waiver_document_id: uploaded.document.id })
    .eq("id", input.invoiceId);
  if (error) {
    // Don't leave the freshly-uploaded doc orphaned in Documents if the link
    // failed — retire it (best-effort) before surfacing the error.
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }

  // Replace: retire the previous waiver doc so the Documents tab isn't cluttered
  // with stale copies (best-effort).
  if (inv.lien_waiver_document_id && inv.lien_waiver_document_id !== uploaded.document.id) {
    await softDeleteDocument(inv.lien_waiver_document_id, input.actorUserId).catch(() => {});
  }
  return { ok: true, value: uploaded.document };
}

/** Unlink (and soft-delete) an invoice's lien waiver. */
export async function removeInvoiceLienWaiver(invoiceId: string, actorUserId: string): Promise<Result<null>> {
  const inv = await fetchInvoiceScope(invoiceId);
  if (!inv) return { ok: false, error: "Invoice not found." };
  const sb = commercialDb();
  const { error } = await sb.from("commercial_invoices").update({ lien_waiver_document_id: null }).eq("id", invoiceId);
  if (error) return { ok: false, error: error.message };
  if (inv.lien_waiver_document_id) {
    await softDeleteDocument(inv.lien_waiver_document_id, actorUserId).catch(() => {});
  }
  return { ok: true, value: null };
}
