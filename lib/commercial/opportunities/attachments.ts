import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  sanitizeFileName,
} from "@/lib/commercial/accounts/documents";

/**
 * Plans & Specs attachments per opportunity (migration 032).
 *
 * Lifts the Phase 1 documents.ts pattern but WITHOUT the category
 * enum — opp files are arbitrary (RFP.pdf / plans_set_A.pdf /
 * proposal_v2.pdf). Auto-version + auto-archive prior when a user
 * re-uploads the same filename (case-insensitive match on
 * lower(file_name)).
 *
 * Reuses the documents.ts MIME + size constants + sanitizer so file
 * validation stays consistent across Phase 1 docs + Phase 2 attachments.
 */

export const OPPORTUNITY_ATTACHMENT_BUCKET = "commercial-opportunity-files";

export type OpportunityAttachment = {
  id: string;
  opportunity_id: string;
  file_name: string;
  storage_key: string;
  size_bytes: number | null;
  mime_type: string | null;
  version: number;
  notes: string | null;
  uploaded_at: string;
  uploaded_by_user_id: string | null;
  archived: boolean;
  archived_at: string | null;
  archived_by_user_id: string | null;
};

/** Service-role client for Storage operations. Mirror documents.ts. */
function storageAdmin() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Per-opp storage path: {account_id}/{opp_id}/{file_id}-{sanitized}. */
export function buildAttachmentKey(
  accountId: string,
  opportunityId: string,
  attachmentId: string,
  fileName: string
): string {
  return `${accountId}/${opportunityId}/${attachmentId}-${sanitizeFileName(fileName)}`;
}

/** List attachments for one opp, separated into active + archived. The
 *  active list is the current files; history lets Alex see what was
 *  superseded (proposal_v1, _v2 stack as version history). */
export async function listOpportunityAttachments(
  opportunity_id: string
): Promise<{ active: OpportunityAttachment[]; history: OpportunityAttachment[] }> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.warn("[commercial/opp-attachments] list failed:", error.message);
    return { active: [], history: [] };
  }
  const rows = (data ?? []) as OpportunityAttachment[];
  return {
    active: rows.filter((r) => !r.archived),
    history: rows.filter((r) => r.archived),
  };
}

/** Bulk: active-attachment count per opp for the list-row "N files"
 *  badge (Batch 5 integration). Single round-trip, no N+1. */
export async function listAttachmentCountByOpp(
  opportunity_ids: string[]
): Promise<Map<string, number>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_attachments")
    .select("opportunity_id")
    .in("opportunity_id", opportunity_ids)
    .eq("archived", false);
  if (error) {
    console.warn("[commercial/opp-attachments] listAttachmentCountByOpp:", error.message);
    return new Map();
  }
  const out = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ opportunity_id: string }>) {
    out.set(row.opportunity_id, (out.get(row.opportunity_id) ?? 0) + 1);
  }
  return out;
}

export type UploadAttachmentInput = {
  opportunity_id: string;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  notes?: string | null;
  data: Uint8Array;
  uploaded_by_user_id: string;
};

/**
 * Upload an attachment. Validates size + MIME, finds any prior file
 * with the same name (case-insensitive) for auto-version + auto-
 * archive, uploads to Storage, inserts metadata, then archives the
 * prior in that order so a concurrent second upload can't strand a
 * "two actives same name" state.
 *
 * On Storage upload failure: no DB row created.
 * On DB insert failure after Storage success: clean up the Storage
 * object so we don't leave orphans.
 */
export async function uploadOpportunityAttachment(
  input: UploadAttachmentInput
): Promise<{ ok: true; attachment: OpportunityAttachment } | { ok: false; error: string }> {
  if (!input.file_name?.trim()) return { ok: false, error: "Missing filename." };
  if (input.size_bytes <= 0) return { ok: false, error: "Empty file." };
  if (input.size_bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too big (${Math.round(input.size_bytes / 1024 / 1024)} MB). Max 50 MB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    return { ok: false, error: `File type not allowed: ${input.mime_type}.` };
  }

  const sb = commercialDb();

  // Chain of trust — guard parent opp + parent account.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "Opportunity not found." };
  const accountId = (opp as { account_id: string }).account_id;
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", accountId)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "Account not found." };

  // Look for an existing active row with the same lower(file_name) so
  // we can auto-version. Same trick as the documents lib's same-
  // category archive-prior pattern, just keyed on name instead.
  const lowerName = input.file_name.trim().toLowerCase();
  const { data: prior } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("opportunity_id", input.opportunity_id)
    .eq("archived", false)
    .filter("file_name", "ilike", input.file_name.trim())
    .maybeSingle();
  const priorRow = (prior as OpportunityAttachment | null) ?? null;
  // Even with ilike + filename match, names differing only in case
  // count as "same file"; lowercase comparison double-checks.
  const isSameFile = priorRow && priorRow.file_name.toLowerCase() === lowerName;
  const nextVersion = isSameFile ? (priorRow.version ?? 0) + 1 : 1;

  // Pre-allocate the attachment row id so the Storage path is
  // deterministic (we need the id BEFORE inserting because the row
  // stores storage_key).
  const attachmentId = crypto.randomUUID();
  const storageKey = buildAttachmentKey(
    accountId,
    input.opportunity_id,
    attachmentId,
    input.file_name
  );

  // 1) Upload to Storage first. If this fails we never touched the DB.
  const sa = storageAdmin();
  const upload = await sa.storage
    .from(OPPORTUNITY_ATTACHMENT_BUCKET)
    .upload(storageKey, input.data, {
      contentType: input.mime_type,
      upsert: false,
    });
  if (upload.error) {
    return { ok: false, error: `Storage upload failed: ${upload.error.message}` };
  }

  // 2) Insert metadata. On failure, clean up Storage.
  const { data: inserted, error: insertErr } = await sb
    .from("commercial_opportunity_attachments")
    .insert({
      id: attachmentId,
      opportunity_id: input.opportunity_id,
      file_name: input.file_name.trim(),
      storage_key: storageKey,
      size_bytes: input.size_bytes,
      mime_type: input.mime_type,
      version: nextVersion,
      notes: input.notes?.trim() || null,
      uploaded_by_user_id: input.uploaded_by_user_id,
    })
    .select("*")
    .single();
  if (insertErr) {
    await sa.storage.from(OPPORTUNITY_ATTACHMENT_BUCKET).remove([storageKey]);
    return { ok: false, error: insertErr.message };
  }
  const attachment = inserted as OpportunityAttachment;
  await logInsert(
    "commercial_opportunity_attachments",
    attachment.id,
    attachment,
    input.uploaded_by_user_id
  );

  // 3) Archive the prior, if any. Race-guarded by .eq("archived", false)
  //    so a concurrent third upload doesn't stomp on each other.
  if (priorRow && isSameFile) {
    const archivedAt = new Date().toISOString();
    const { data: archived } = await sb
      .from("commercial_opportunity_attachments")
      .update({
        archived: true,
        archived_at: archivedAt,
        archived_by_user_id: input.uploaded_by_user_id,
      })
      .eq("id", priorRow.id)
      .eq("archived", false)
      .select("*")
      .single();
    if (archived) {
      await logUpdate(
        "commercial_opportunity_attachments",
        priorRow.id,
        priorRow,
        archived,
        input.uploaded_by_user_id
      );
    }
  }

  return { ok: true, attachment };
}

/** Archive an attachment without replacement. File stays downloadable
 *  in History for the audit trail. */
export async function archiveOpportunityAttachment(
  opportunity_id: string,
  attachment_id: string,
  acting_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("id", attachment_id)
    .eq("opportunity_id", opportunity_id)
    .eq("archived", false)
    .maybeSingle();
  if (!before) return { ok: false, error: "Attachment not found or already archived." };
  const { data: after, error } = await sb
    .from("commercial_opportunity_attachments")
    .update({
      archived: true,
      archived_at: new Date().toISOString(),
      archived_by_user_id: acting_user_id ?? null,
    })
    .eq("id", attachment_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_opportunity_attachments",
    attachment_id,
    before,
    after,
    acting_user_id
  );
  return { ok: true };
}

/** Generate a short-TTL signed URL for downloading an attachment.
 *  Default 5 minutes — same as Phase 1 documents. */
export async function getOpportunityAttachmentSignedUrl(
  storage_key: string,
  ttlSeconds: number = 5 * 60
): Promise<string | null> {
  const sa = storageAdmin();
  const { data, error } = await sa.storage
    .from(OPPORTUNITY_ATTACHMENT_BUCKET)
    .createSignedUrl(storage_key, ttlSeconds);
  if (error) {
    console.warn("[commercial/opp-attachments] signed URL failed:", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/** Format byte count to a glanceable string ("2.3 MB", "412 KB"). */
export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
