import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { uploadDocument, getDocument, softDeleteDocument } from "@/lib/commercial/documents/db";
import type { CommercialDocument } from "@/lib/commercial/documents/db";

/**
 * Lien waiver ↔ AIA application. (Stephanie 2026-08-20: "Add lien waiver option
 * to AIA billing just as it is under the invoicing.")
 *
 * Deliberately the same shape as invoices/lien-waiver.ts: the file is stored
 * ONCE as a per-deal document (parent_type=opportunity, category=lien_waiver)
 * so it lands in the deal's Documents tab on its own, and the application row
 * links to it. Stored, never generated — Katie's rule: the GC sends the waiver,
 * we sign and return it, and the platform keeps the copy.
 *
 * Why the application needs its own link rather than borrowing the invoice's:
 * on a progress-billed job the requisition IS the payment request. Each
 * application carries the partial waiver for its own period, and the final one
 * carries the final waiver. Hanging them off invoices would file the waiver for
 * Application No. 3 under whichever invoice happened to exist.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function fetchApplicationScope(
  applicationId: string
): Promise<{ opportunity_id: string; application_number: number; lien_waiver_document_id: string | null } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_aia_applications")
    .select("opportunity_id, application_number, lien_waiver_document_id")
    .eq("id", applicationId)
    .is("deleted_at", null)
    .maybeSingle<{ opportunity_id: string; application_number: number; lien_waiver_document_id: string | null }>();
  return data ?? null;
}

export async function getAiaLienWaiver(applicationId: string): Promise<CommercialDocument | null> {
  const app = await fetchApplicationScope(applicationId);
  if (!app?.lien_waiver_document_id) return null;
  // The document may have been removed from the Documents tab — treat a
  // dangling link as "nothing on file" rather than showing a ✓ for a file that
  // is gone. (The FK is ON DELETE SET NULL, but a soft delete leaves the row.)
  const doc = await getDocument(app.lien_waiver_document_id);
  return doc ?? null;
}

/** Store a waiver against one application. Replaces any prior one. */
export async function attachAiaLienWaiver(input: {
  applicationId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const app = await fetchApplicationScope(input.applicationId);
  if (!app) return { ok: false, error: "Application not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: app.opportunity_id,
    category: "lien_waiver",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Lien waiver — AIA Application No. ${app.application_number}`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_aia_applications")
    .update({ lien_waiver_document_id: uploaded.document.id })
    .eq("id", input.applicationId);
  if (error) {
    // Don't strand the freshly-uploaded file in Documents when the link fails.
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }

  // Replacing: retire the previous one so the Documents tab doesn't collect
  // stale copies of the same waiver.
  if (app.lien_waiver_document_id && app.lien_waiver_document_id !== uploaded.document.id) {
    await softDeleteDocument(app.lien_waiver_document_id, input.actorUserId).catch(() => {});
  }
  return { ok: true, value: uploaded.document };
}

/** Unlink and retire an application's waiver. */
export async function removeAiaLienWaiver(
  applicationId: string,
  actorUserId: string
): Promise<Result<null>> {
  const app = await fetchApplicationScope(applicationId);
  if (!app) return { ok: false, error: "Application not found." };
  if (!app.lien_waiver_document_id) return { ok: true, value: null };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_aia_applications")
    .update({ lien_waiver_document_id: null })
    .eq("id", applicationId);
  if (error) return { ok: false, error: error.message };
  await softDeleteDocument(app.lien_waiver_document_id, actorUserId).catch(() => {});
  return { ok: true, value: null };
}
