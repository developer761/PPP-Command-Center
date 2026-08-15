import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  verifyFileMagicBytes,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/commercial/accounts/documents";
import { sniffRemoteHead } from "@/lib/commercial/documents/large-upload";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  OPPORTUNITY_ATTACHMENT_BUCKET,
  buildAttachmentKey,
  type OpportunityAttachment,
} from "./attachments";

/**
 * LARGE plan/spec/RFP attachment uploads (Karan 2026-08-14) — uploaded DIRECTLY
 * from the browser to Supabase Storage via a signed URL, exactly like the
 * Documents system's large-upload flow.
 *
 * Why: the multipart path (attachments/route.ts) buffers the whole file on a
 * Vercel serverless function, which caps the request body at ~4.5 MB — so a
 * 17 MB receipts PDF (or any real bid set) 413s at the platform edge before our
 * code runs, even though the uploader advertises "max 50 MB". The bytes go
 * straight to Storage instead:
 *
 *   1. sign()     — validate + guard, mint a one-time signed upload URL.
 *   2. <browser>  — PUTs the file to Storage (bypasses Vercel entirely).
 *   3. finalize() — confirm it landed, magic-byte-sniff its head (no full
 *                   download), then run the SAME auto-version + auto-archive
 *                   insert uploadOpportunityAttachment() does. Kept in sync.
 */

async function guardParent(
  opportunityId: string
): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunityId)
    .maybeSingle();
  if (!opp || (opp as { deleted_at?: string | null }).deleted_at) {
    return { ok: false, error: "Opportunity not found." };
  }
  const accountId = (opp as { account_id: string }).account_id;
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", accountId)
    .maybeSingle();
  if (!acct || (acct as { deleted_at?: string | null }).deleted_at) {
    return { ok: false, error: "Account not found." };
  }
  return { ok: true, accountId };
}

export type SignAttachmentInput = {
  opportunity_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
};

/** Step 1 — mint a one-time signed upload URL for a new attachment. */
export async function signAttachmentUpload(
  input: SignAttachmentInput
): Promise<
  | { ok: true; bucket: string; storage_key: string; token: string }
  | { ok: false; error: string }
> {
  if (!input.file_name?.trim()) return { ok: false, error: "Missing filename." };
  if (!Number.isFinite(input.size_bytes) || input.size_bytes <= 0) {
    return { ok: false, error: "Empty file." };
  }
  if (input.size_bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too big (${Math.round(input.size_bytes / 1024 / 1024)} MB). Max ${Math.round(
        MAX_UPLOAD_BYTES / 1024 / 1024
      )} MB.`,
    };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    return { ok: false, error: `File type not allowed: ${input.mime_type || "(unknown)"}.` };
  }

  const guard = await guardParent(input.opportunity_id);
  if (!guard.ok) return guard;

  // Pre-allocate the row id so the Storage key is deterministic and finalize can
  // re-derive it from the key (the id IS the leaf's leading segment).
  const attachmentId = crypto.randomUUID();
  const storageKey = buildAttachmentKey(
    guard.accountId,
    input.opportunity_id,
    attachmentId,
    input.file_name
  );

  const { data, error } = await commercialDb()
    .storage.from(OPPORTUNITY_ATTACHMENT_BUCKET)
    .createSignedUploadUrl(storageKey);
  if (error || !data?.token) {
    return { ok: false, error: `Could not start upload: ${error?.message ?? "no token"}` };
  }
  return { ok: true, bucket: OPPORTUNITY_ATTACHMENT_BUCKET, storage_key: storageKey, token: data.token };
}

export type FinalizeAttachmentInput = {
  opportunity_id: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  notes?: string | null;
  uploaded_by_user_id: string;
};

/**
 * Step 3 — after the direct PUT lands, confirm the object, sniff its head for a
 * magic-byte match, then run the SAME auto-version + auto-archive insert the
 * multipart path does. On any failure the orphaned object is removed.
 */
export async function finalizeAttachmentUpload(
  input: FinalizeAttachmentInput
): Promise<{ ok: true; attachment: OpportunityAttachment } | { ok: false; error: string }> {
  const sb = commercialDb();

  // ─── Ownership FIRST — before anything can delete an object ───────────────
  // `storage_key` is caller-supplied and every cleanup path below deletes that
  // exact key, so the prefix check has to come before the first removeObject()
  // call — otherwise naming another deal's key and deliberately failing an
  // early check (e.g. an empty mime type) deletes that deal's file for good.
  const guard = await guardParent(input.opportunity_id);
  if (!guard.ok) {
    return guard;
  }
  const expectedPrefix = `${guard.accountId}/${input.opportunity_id}/`;
  if (!input.storage_key.startsWith(expectedPrefix)) {
    return { ok: false, error: "That upload doesn't belong to this deal." };
  }
  const leaf = input.storage_key.slice(expectedPrefix.length);
  const attachmentId = leaf.split("-", 5).join("-"); // uuid = first 5 dash-groups
  if (!UUID_RE.test(attachmentId)) {
    return { ok: false, error: "Malformed upload reference." };
  }

  // Safe from here: the key is inside this deal's own prefix.
  const removeObject = () =>
    sb.storage.from(OPPORTUNITY_ATTACHMENT_BUCKET).remove([input.storage_key]).catch(() => undefined);

  if (!input.file_name?.trim()) {
    await removeObject();
    return { ok: false, error: "Missing filename." };
  }
  if (!ALLOWED_MIME_TYPES.has(input.mime_type)) {
    await removeObject();
    return { ok: false, error: `File type not allowed: ${input.mime_type || "(unknown)"}.` };
  }

  // Confirm the object landed + sniff its head + read its true size.
  const { data: signed } = await sb.storage
    .from(OPPORTUNITY_ATTACHMENT_BUCKET)
    .createSignedUrl(input.storage_key, 60);
  if (!signed?.signedUrl) {
    return { ok: false, error: "Upload not found — please try again." };
  }
  const head = await sniffRemoteHead(signed.signedUrl);
  if (!head.ok) {
    await removeObject();
    return head;
  }
  const magic = verifyFileMagicBytes(head.head, input.mime_type);
  if (!magic.ok) {
    await removeObject();
    return { ok: false, error: `File content doesn't match its type (${magic.detected}).` };
  }
  const size = head.totalSize;
  if (size !== null && size > MAX_UPLOAD_BYTES) {
    await removeObject();
    return { ok: false, error: `File too big (${Math.round(size / 1024 / 1024)} MB).` };
  }
  if (size !== null && size <= 0) {
    await removeObject();
    return { ok: false, error: "Empty file." };
  }

  // Auto-version: find any active row with the same lower(file_name).
  const lowerName = input.file_name.trim().toLowerCase();
  const { data: prior } = await sb
    .from("commercial_opportunity_attachments")
    .select("*")
    .eq("opportunity_id", input.opportunity_id)
    .eq("archived", false)
    .filter("file_name", "ilike", input.file_name.trim())
    .maybeSingle();
  const priorRow = (prior as OpportunityAttachment | null) ?? null;
  const isSameFile = priorRow && priorRow.file_name.toLowerCase() === lowerName;
  const nextVersion = isSameFile ? (priorRow.version ?? 0) + 1 : 1;

  const { data: inserted, error: insertErr } = await sb
    .from("commercial_opportunity_attachments")
    .insert({
      id: attachmentId,
      opportunity_id: input.opportunity_id,
      file_name: input.file_name.trim(),
      storage_key: input.storage_key,
      size_bytes: size ?? 0,
      mime_type: input.mime_type,
      version: nextVersion,
      notes: input.notes?.trim().slice(0, 500) || null,
      uploaded_by_user_id: input.uploaded_by_user_id,
    })
    .select("*")
    .single();
  if (insertErr) {
    // UNIQUE violation = this key already has a committed row (a retried
    // finalize), not an orphan. Removing the object would strand that row with
    // no bytes behind it, so hand back the existing attachment instead.
    if ((insertErr as { code?: string }).code === "23505") {
      const { data: existing } = await sb
        .from("commercial_opportunity_attachments")
        .select("*")
        .eq("storage_key", input.storage_key)
        .maybeSingle();
      if (existing) return { ok: true, attachment: existing as OpportunityAttachment };
      return { ok: false, error: insertErr.message };
    }
    await removeObject();
    return { ok: false, error: insertErr.message };
  }
  const attachment = inserted as OpportunityAttachment;
  await logInsert("commercial_opportunity_attachments", attachment.id, attachment, input.uploaded_by_user_id);

  // Archive the prior version — race-guarded by .eq("archived", false).
  if (priorRow && isSameFile) {
    const { data: archived } = await sb
      .from("commercial_opportunity_attachments")
      .update({
        archived: true,
        archived_at: new Date().toISOString(),
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
      ).catch(() => undefined);
    }
  }

  return { ok: true, attachment };
}
