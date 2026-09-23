import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { softDeleteDocument } from "@/lib/commercial/documents/db";
import { logUpdate } from "@/lib/commercial/audit-log";

/**
 * File an ALREADY-UPLOADED document as a lien waiver.
 *
 * The four waiver slots each stored the file by posting its bytes to a route,
 * which meant they inherited Vercel's ~4.5 MB request-body cap. A scanned
 * waiver from a GC is routinely 5–15 MB, so the common case did not fit, and
 * the browser guard's advice — "put it on the Documents tab instead" — parked
 * the file somewhere it was never linked, leaving the slot reading "Missing"
 * with the waiver sitting three feet away. Explaining a trap is not fixing it.
 *
 * So the bytes now travel the way every other large file already does:
 * straight from the browser to Storage via the Documents sign → PUT →
 * finalize path, which handles the full upload limit. All that is left for the
 * server is to point the slot at the resulting document, which is what this
 * does. A waiver was ALWAYS stored as a `commercial_document` and linked by
 * id — see attachInvoiceLienWaiver — so nothing about the data model changes.
 *
 * The check that matters is scope: a document id is a user-supplied value, and
 * without verification someone could link any document in the platform — a
 * different GC's pricing, say — into their own invoice's waiver slot and then
 * download it through the waiver route. So the document must already belong to
 * the same opportunity as the target.
 */

export type LienWaiverTarget = "invoice" | "milestone" | "payment" | "aia";

type TargetRow = {
  table: string;
  /** The deal this row belongs to — the scope a document must match. */
  opportunityId: string;
  previousDocumentId: string | null;
};

/** Resolve a target to its table, its deal, and whatever waiver it already has. */
async function resolveTarget(
  target: LienWaiverTarget,
  id: string
): Promise<TargetRow | null> {
  const sb = commercialDb();

  if (target === "invoice") {
    const { data } = await sb
      .from("commercial_invoices")
      .select("id, opportunity_id, lien_waiver_document_id, deleted_at")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    const row = data as { opportunity_id: string; lien_waiver_document_id: string | null } | null;
    return row
      ? { table: "commercial_invoices", opportunityId: row.opportunity_id, previousDocumentId: row.lien_waiver_document_id }
      : null;
  }

  if (target === "aia") {
    const { data } = await sb
      .from("commercial_aia_applications")
      .select("id, opportunity_id, lien_waiver_document_id, deleted_at")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    const row = data as { opportunity_id: string; lien_waiver_document_id: string | null } | null;
    return row
      ? { table: "commercial_aia_applications", opportunityId: row.opportunity_id, previousDocumentId: row.lien_waiver_document_id }
      : null;
  }

  // Milestones and payments hang off an invoice, so the deal comes from there.
  const table = target === "milestone" ? "commercial_invoice_milestones" : "commercial_invoice_payments";
  const { data } = await sb
    .from(table)
    .select("id, invoice_id, lien_waiver_document_id, deleted_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as { invoice_id: string; lien_waiver_document_id: string | null } | null;
  if (!row) return null;

  const { data: inv } = await sb
    .from("commercial_invoices")
    .select("opportunity_id, deleted_at")
    .eq("id", row.invoice_id)
    .is("deleted_at", null)
    .maybeSingle();
  const invoice = inv as { opportunity_id: string } | null;
  if (!invoice) return null;

  return { table, opportunityId: invoice.opportunity_id, previousDocumentId: row.lien_waiver_document_id };
}

export async function linkLienWaiverDocument(input: {
  target: LienWaiverTarget;
  id: string;
  documentId: string;
  actorUserId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  const targetRow = await resolveTarget(input.target, input.id);
  if (!targetRow) return { ok: false, error: "That record no longer exists." };

  const { data: docRow } = await sb
    .from("commercial_documents")
    .select("id, parent_type, parent_id, category, deleted_at")
    .eq("id", input.documentId)
    .is("deleted_at", null)
    .maybeSingle();
  const doc = docRow as
    | { id: string; parent_type: string; parent_id: string; category: string }
    | null;
  if (!doc) return { ok: false, error: "That upload is no longer available — try again." };

  // SCOPE. Without this the document id is an open door into any file on the
  // platform: link it here, then download it through the waiver route.
  if (doc.parent_type !== "opportunity" || doc.parent_id !== targetRow.opportunityId) {
    return { ok: false, error: "That document belongs to a different job." };
  }

  const before = { lien_waiver_document_id: targetRow.previousDocumentId };
  const { error } = await sb
    .from(targetRow.table)
    .update({ lien_waiver_document_id: doc.id })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  await logUpdate(
    targetRow.table,
    input.id,
    before,
    { lien_waiver_document_id: doc.id },
    input.actorUserId
  );

  // Replacing a waiver retires the old one, so the Documents tab doesn't fill
  // with stale copies. Best-effort, exactly as the byte-upload path does it —
  // failing to tidy up must not fail the filing.
  if (targetRow.previousDocumentId && targetRow.previousDocumentId !== doc.id) {
    await softDeleteDocument(targetRow.previousDocumentId, input.actorUserId).catch(() => {});
  }

  return { ok: true };
}
