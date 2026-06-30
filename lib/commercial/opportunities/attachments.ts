import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { reportWarn } from "@/lib/observability";
import { verifyOppEditable, loadOppContextOrNull } from "./guards";
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
  // Phase 2.5 — optional link to a specific submittal. NULL = generic
  // Plans/Specs attachment that's not tied to any one submittal.
  // ON DELETE SET NULL on the FK so voiding a submittal preserves the PDF.
  submittal_id: string | null;
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
  // Audit fix 2026-06-24: gate listing on the parent opp's deleted_at
  // so attachments don't leak after a soft-delete. Uploads were already
  // gated; listing path was the gap.
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  if (!oppRow || (oppRow as { deleted_at: string | null }).deleted_at) {
    return { active: [], history: [] };
  }
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

/**
 * Best-effort filename → category tag. Commercial estimators ship a
 * handful of canonical doc types per bid (RFP, plan set, spec book,
 * proposal, change order, submittal). A quick badge by name pattern
 * helps Alex scan a stack of 20 files without opening each.
 *
 * Pattern matches are intentionally loose; if no pattern hits we omit
 * the tag rather than render "Other" — silence beats noise.
 */
export type AttachmentCategory =
  | "RFP"
  | "Plans"
  | "Specs"
  | "Proposal"
  | "Change Order"
  | "Submittal"
  | "Invoice"
  | "Contract";

export function categorizeFilename(name: string): AttachmentCategory | null {
  const lower = name.toLowerCase();
  if (/\brfp\b|request[\s_-]*for[\s_-]*proposal/.test(lower)) return "RFP";
  if (/\bsubmittal\b|\bsubmit\b/.test(lower)) return "Submittal";
  if (/\bchange[\s_-]*order\b|\bco[\s_-]*\d/.test(lower)) return "Change Order";
  if (/\bcontract\b|\bagreement\b|\bmsa\b/.test(lower)) return "Contract";
  if (/\binvoice\b|\bbilling\b/.test(lower)) return "Invoice";
  if (/\bproposal\b|\bbid\b|\bquote\b|\bestimate\b/.test(lower)) return "Proposal";
  if (/\bspec(s|ifications?|book)?\b|\bsection[\s_-]*\d/.test(lower)) return "Specs";
  if (/\bplan(s|set)?\b|\bdrawing\b|\barch\b|\bblueprint\b|sheet[\s_-]*[a-z0-9]+/.test(lower)) return "Plans";
  return null;
}

// ─── Phase 2.5: submittal linkage ────────────────────────────────────
//
// Attachments live on the opportunity (Plans & Specs tab). Some of them
// belong to a specific submittal package — the spec sheets, drawdowns,
// color charts that Tomco bundled into SUB-001. We link via the
// commercial_opportunity_attachments.submittal_id column added in
// migration 041. ON DELETE SET NULL on the FK so voiding a submittal
// preserves the underlying PDF on the Plans & Specs tab.

/**
 * List active attachments linked to a specific submittal. Used by the
 * submittal detail page's "Attached spec sheets" section.
 *
 * Chain-of-trust: lib already gates listings via the opp's deleted_at
 * (see listOpportunityAttachments). Same shape here.
 */
export async function listAttachmentsBySubmittal(
  opportunity_id: string,
  submittal_id: string
): Promise<OpportunityAttachment[]> {
  const sb = commercialDb();
  if (!(await loadOppContextOrNull(opportunity_id))) return [];

  const { data, error } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .eq("submittal_id", submittal_id)
    .eq("archived", false)
    .order("uploaded_at", { ascending: false });
  if (error) {
    reportWarn({
      key: "submittal_attachments_list_failed",
      message: "Submittal-attachment list query failed",
      platform: "commercial_cc",
      context: { opp: opportunity_id.slice(0, 8), sub: submittal_id.slice(0, 8), err_code: (error as { code?: string }).code ?? "unknown" },
    });
    return [];
  }
  return (data ?? []) as OpportunityAttachment[];
}

/**
 * List active attachments on this opp that are NOT yet linked to any
 * submittal. Feeds the "Link existing PDF" picker on the submittal
 * detail page so Alex sees only files that are available to link.
 */
export async function listUnlinkedOpportunityAttachments(
  opportunity_id: string
): Promise<OpportunityAttachment[]> {
  const sb = commercialDb();
  if (!(await loadOppContextOrNull(opportunity_id))) return [];

  const { data, error } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .is("submittal_id", null)
    .eq("archived", false)
    .order("uploaded_at", { ascending: false });
  if (error) {
    reportWarn({
      key: "unlinked_attachments_list_failed",
      message: "Unlinked-attachment list query failed",
      platform: "commercial_cc",
      context: { opp: opportunity_id.slice(0, 8), err_code: (error as { code?: string }).code ?? "unknown" },
    });
    return [];
  }
  return (data ?? []) as OpportunityAttachment[];
}

/**
 * Link an existing attachment to a specific submittal. Defense in depth:
 * the lib double-scopes by opportunity_id + verifies the submittal
 * belongs to that opp AND is not voided (voided submittals can't gain
 * new attachments). Mirror of yesterday's cross-account fix shape.
 */
export async function linkAttachmentToSubmittal(
  opportunity_id: string,
  submittal_id: string,
  attachment_id: string,
  acting_user_id: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  const oppGuard = await verifyOppEditable(opportunity_id);
  if (!oppGuard.ok) return { ok: false, error: oppGuard.error };

  // Verify the submittal is on this opp AND not voided.
  const { data: subRow } = await sb
    .from("commercial_opp_submittals")
    .select("id, opportunity_id, status")
    .eq("id", submittal_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!subRow) return { ok: false, error: "Submittal not found on this opportunity." };
  const sub = subRow as { id: string; opportunity_id: string; status: string };
  if (sub.status === "voided") {
    return { ok: false, error: "Cannot link to a voided submittal." };
  }

  // Load before-state for audit log + verify scope.
  const { data: before } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("id", attachment_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Attachment not found on this opportunity." };
  const beforeRow = before as OpportunityAttachment;
  if (beforeRow.archived) return { ok: false, error: "Cannot link an archived attachment." };

  // Idempotent: already linked to this exact submittal → no-op success.
  if (beforeRow.submittal_id === submittal_id) return { ok: true };

  // Race-guard: re-assert archived=false in WHERE so a concurrent archive
  // can't slip through and link a now-archived attachment (audit
  // data-integrity #3, 2026-06-30).
  const { data: after, error: updErr } = await sb
    .from("commercial_opportunity_attachments")
    .update({ submittal_id })
    .eq("id", attachment_id)
    .eq("opportunity_id", opportunity_id)
    .eq("archived", false)
    .select("*")
    .maybeSingle();
  if (updErr) return { ok: false, error: updErr.message };
  if (!after) {
    return { ok: false, error: "Attachment was archived in another tab. Reload to see the latest." };
  }

  await logUpdate(
    "commercial_opportunity_attachments",
    attachment_id,
    before,
    after,
    acting_user_id
  );
  return { ok: true };
}

/**
 * Unlink an attachment from its submittal (sets submittal_id = NULL).
 * The file stays on Plans & Specs — only the linkage is removed.
 */
export async function unlinkAttachmentFromSubmittal(
  opportunity_id: string,
  submittal_id: string,
  attachment_id: string,
  acting_user_id: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  const oppGuard = await verifyOppEditable(opportunity_id);
  if (!oppGuard.ok) return { ok: false, error: oppGuard.error };

  const { data: before } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("id", attachment_id)
    .eq("opportunity_id", opportunity_id)
    .eq("submittal_id", submittal_id)
    .maybeSingle();
  if (!before) {
    return { ok: false, error: "Attachment not found or not linked to this submittal." };
  }

  const { data: after, error: updErr } = await sb
    .from("commercial_opportunity_attachments")
    .update({ submittal_id: null })
    .eq("id", attachment_id)
    .eq("opportunity_id", opportunity_id)
    .eq("submittal_id", submittal_id)  // race-guard: only unlink if still linked here
    .select("*")
    .maybeSingle();
  if (updErr) return { ok: false, error: updErr.message };
  if (!after) {
    return { ok: false, error: "Attachment was relinked in another tab. Reload to see the latest." };
  }

  await logUpdate(
    "commercial_opportunity_attachments",
    attachment_id,
    before,
    after,
    acting_user_id
  );
  return { ok: true };
}
