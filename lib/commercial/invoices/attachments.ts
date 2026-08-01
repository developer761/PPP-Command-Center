import "server-only";

/**
 * Invoice attachments (Phase 2). Arbitrary files attached to a specific invoice
 * (a signed contract copy, a photo, a spec sheet sent with the bill). Since
 * commercial_documents has no "invoice" parent_type, the file parents to the
 * OPPORTUNITY (so it also shows in the deal Documents tab) and a
 * commercial_invoice_attachments link row scopes it to the one invoice for the
 * invoice-detail listing. The invoice number is stamped into the doc notes
 * (audit H4) so the deal Documents tab can tell which invoice it came from.
 *
 * Teardown note: attachment docs are parented to the live opportunity, so they
 * are never orphaned — soft-deleting the invoice retains them as valid deal
 * documents (supports restore); the link row cascade-drops only on a hard
 * invoice delete (which the app never does). Explicit removal retires the doc.
 */

import { commercialDb } from "@/lib/commercial/db";
import { uploadDocument, softDeleteDocument, getDocumentsByIds, type CommercialDocument } from "@/lib/commercial/documents/db";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchInvoiceScope(invoiceId: string): Promise<{ opportunity_id: string; invoice_number: string } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoices")
    .select("opportunity_id, invoice_number, deleted_at")
    .eq("id", invoiceId)
    .maybeSingle();
  const row = data as { opportunity_id: string; invoice_number: string; deleted_at: string | null } | null;
  if (!row || row.deleted_at) return null;
  return { opportunity_id: row.opportunity_id, invoice_number: row.invoice_number };
}

export async function attachInvoiceFile(input: {
  invoiceId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const scope = await fetchInvoiceScope(input.invoiceId);
  if (!scope) return { ok: false, error: "Invoice not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: scope.opportunity_id,
    category: "invoice_attachment",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Attachment — ${scope.invoice_number}`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb.from("commercial_invoice_attachments").insert({
    invoice_id: input.invoiceId,
    document_id: uploaded.document.id,
    created_by_user_id: input.actorUserId,
    created_at: new Date().toISOString(),
  });
  if (error) {
    // Link failed → retire the just-uploaded doc so it doesn't float unattached.
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }
  return { ok: true, value: uploaded.document };
}

/** Live attachment docs for an invoice, newest first. */
export async function listInvoiceAttachments(invoiceId: string): Promise<CommercialDocument[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_attachments")
    .select("document_id")
    .eq("invoice_id", invoiceId);
  if (error) return []; // tolerate unapplied migration
  const ids = ((data ?? []) as { document_id: string }[]).map((r) => r.document_id);
  if (ids.length === 0) return [];
  const docs = await getDocumentsByIds(ids); // soft-delete-aware
  return [...docs.values()].sort((a, b) => (b.uploaded_at ?? "").localeCompare(a.uploaded_at ?? ""));
}

/** Batch: does each invoice have any live attachment? (deal Invoices tab chip.) */
export async function invoiceIdsWithAttachment(invoiceIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoice_attachments")
    .select("invoice_id")
    .in("invoice_id", ids);
  for (const r of (data ?? []) as { invoice_id: string }[]) out.add(r.invoice_id);
  return out;
}

export async function removeInvoiceAttachment(
  invoiceId: string,
  documentId: string,
  actorUserId: string
): Promise<Result<null>> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_attachments")
    .delete()
    .eq("invoice_id", invoiceId)
    .eq("document_id", documentId);
  if (error) return { ok: false, error: error.message };
  await softDeleteDocument(documentId, actorUserId).catch(() => {});
  return { ok: true, value: null };
}
