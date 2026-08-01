import "server-only";

/**
 * Change-order attachments (Phase 2, 2026-08). Signed CO PDFs / backup attached
 * to a SPECIFIC change order — mirrors commercial_invoice_attachments exactly.
 *
 * commercial_change_orders has no doc column, so the file parents to the
 * OPPORTUNITY (category "change_order", so it also rolls up to the deal
 * Documents → Change Orders box) and a commercial_change_order_attachments link
 * row scopes it to the one change order. The CO number is stamped into the doc
 * notes so the Documents box shows which CO each file belongs to.
 */

import { commercialDb } from "@/lib/commercial/db";
import { uploadDocument, softDeleteDocument, getDocumentsByIds, type CommercialDocument } from "@/lib/commercial/documents/db";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchChangeOrderScope(changeOrderId: string): Promise<{ opportunity_id: string; co_number: number } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_change_orders")
    .select("opportunity_id, co_number, deleted_at")
    .eq("id", changeOrderId)
    .maybeSingle();
  const row = data as { opportunity_id: string; co_number: number; deleted_at: string | null } | null;
  if (!row || row.deleted_at) return null;
  return { opportunity_id: row.opportunity_id, co_number: row.co_number };
}

function coLabel(co_number: number): string {
  return `CO-${String(co_number).padStart(3, "0")}`;
}

export async function attachChangeOrderFile(input: {
  changeOrderId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const scope = await fetchChangeOrderScope(input.changeOrderId);
  if (!scope) return { ok: false, error: "Change order not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: scope.opportunity_id,
    category: "change_order",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Change order — ${coLabel(scope.co_number)}`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb.from("commercial_change_order_attachments").insert({
    change_order_id: input.changeOrderId,
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

/** Live attachment docs for ONE change order, newest first. */
export async function listChangeOrderAttachments(changeOrderId: string): Promise<CommercialDocument[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_change_order_attachments")
    .select("document_id")
    .eq("change_order_id", changeOrderId);
  if (error) return []; // tolerate unapplied migration
  const ids = ((data ?? []) as { document_id: string }[]).map((r) => r.document_id);
  if (ids.length === 0) return [];
  const docs = await getDocumentsByIds(ids); // soft-delete-aware
  return [...docs.values()].sort((a, b) => (b.uploaded_at ?? "").localeCompare(a.uploaded_at ?? ""));
}

/** Batch: attachment docs for MANY change orders at once (the CO panel). Keyed
 *  by change_order_id, each list newest-first. One link query + one docs query. */
export async function changeOrderAttachmentsByOrder(changeOrderIds: string[]): Promise<Map<string, CommercialDocument[]>> {
  const out = new Map<string, CommercialDocument[]>();
  const ids = [...new Set(changeOrderIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_change_order_attachments")
    .select("change_order_id, document_id")
    .in("change_order_id", ids);
  if (error) return out; // tolerate unapplied migration
  const links = (data ?? []) as { change_order_id: string; document_id: string }[];
  const docs = await getDocumentsByIds(links.map((l) => l.document_id)); // soft-delete-aware
  for (const l of links) {
    const doc = docs.get(l.document_id);
    if (!doc) continue; // doc soft-deleted from the Documents tab
    const arr = out.get(l.change_order_id) ?? [];
    arr.push(doc);
    out.set(l.change_order_id, arr);
  }
  for (const [k, arr] of out) arr.sort((a, b) => (b.uploaded_at ?? "").localeCompare(a.uploaded_at ?? ""));
  return out;
}

export async function removeChangeOrderAttachment(
  changeOrderId: string,
  documentId: string,
  actorUserId: string
): Promise<Result<null>> {
  const sb = commercialDb();
  // Scope the delete to THIS change order's link, and only retire the doc if the
  // link actually matched (mirrors the invoice-attachment HIGH fix): a forged
  // document_id for a doc attached elsewhere must NOT be soft-deleted. Supabase
  // returns no error on a 0-row delete — so gate on the returned rows.
  const { data, error } = await sb
    .from("commercial_change_order_attachments")
    .delete()
    .eq("change_order_id", changeOrderId)
    .eq("document_id", documentId)
    .select("document_id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Attachment not found on this change order." };
  }
  await softDeleteDocument(documentId, actorUserId).catch(() => {});
  return { ok: true, value: null };
}
