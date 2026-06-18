import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import type { ArchiveKind } from "./address";

/**
 * Read-side types + helpers for commercial_archived_emails.
 *
 * Strict separation: this file must not import from the inbound webhook
 * handler. The webhook OWNS writes; this file owns reads + the soft-delete
 * mutation. Keeps the data flow one-directional.
 */

export type ArchivedEmailClassification = "internal" | "external" | "system";

export type ArchivedEmailAttachment = {
  filename: string;
  size_bytes: number;
  mime_type: string;
  storage_key: string;
};

export type ArchivedEmail = {
  id: string;
  source_kind: ArchiveKind;
  source_id: string;
  message_id: string;
  in_reply_to: string | null;
  from_email: string;
  from_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  body_truncated: boolean;
  attachments: ArchivedEmailAttachment[];
  classification: ArchivedEmailClassification;
  received_at: string;
  created_at: string;
  deleted_at: string | null;
};

/** Newest-first list of archived emails for one source record. UI uses
 *  this on the Email Archive tab. */
export async function listArchivedEmails(
  source_kind: ArchiveKind,
  source_id: string
): Promise<ArchivedEmail[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_archived_emails")
    .select(
      "id, source_kind, source_id, message_id, in_reply_to, from_email, from_name, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, body_truncated, attachments, classification, received_at, created_at, deleted_at"
    )
    .eq("source_kind", source_kind)
    .eq("source_id", source_id)
    .is("deleted_at", null)
    .order("received_at", { ascending: false });
  if (error) {
    console.warn("[email-archive/db] list failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as ArchivedEmail[]).map((r) => ({
    ...r,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    to_emails: Array.isArray(r.to_emails) ? r.to_emails : [],
    cc_emails: Array.isArray(r.cc_emails) ? r.cc_emails : [],
    bcc_emails: Array.isArray(r.bcc_emails) ? r.bcc_emails : [],
  }));
}

/** Bulk: count of archived emails per source_id for a set of records.
 *  Used on the list pages so each row can show "📧 N" without N+1. */
export async function countArchivedEmailsBySource(
  source_kind: ArchiveKind,
  source_ids: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (source_ids.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_archived_emails")
    .select("source_id")
    .eq("source_kind", source_kind)
    .in("source_id", source_ids)
    .is("deleted_at", null);
  if (error) {
    console.warn("[email-archive/db] countBySource failed:", error.message);
    return out;
  }
  for (const r of (data ?? []) as Array<{ source_id: string }>) {
    out.set(r.source_id, (out.get(r.source_id) ?? 0) + 1);
  }
  return out;
}

/** Most-recent received_at per source — drives the Hot Deal Cooling
 *  reconciliation (Stage 1 cron checks email recency before alerting). */
export async function lastArchivedEmailAtBySource(
  source_kind: ArchiveKind,
  source_ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (source_ids.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_archived_emails")
    .select("source_id, received_at")
    .eq("source_kind", source_kind)
    .in("source_id", source_ids)
    .is("deleted_at", null)
    .order("received_at", { ascending: false });
  if (error) {
    console.warn("[email-archive/db] lastAtBySource failed:", error.message);
    return out;
  }
  for (const r of (data ?? []) as Array<{ source_id: string; received_at: string }>) {
    if (!out.has(r.source_id)) out.set(r.source_id, r.received_at);
  }
  return out;
}

/** Soft-delete an archived email. Audit-trail via deleted_by_user_id —
 *  not a logUpdate row because the email itself doesn't change, only
 *  the visibility flag. */
export async function softDeleteArchivedEmail(
  id: string,
  acting_user_id: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_archived_emails")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by_user_id: acting_user_id ?? null,
    })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Resolve a shortId (first 8 hex chars of a UUID) to the full UUID +
 *  display name for inbound HMAC verification.
 *
 *  Audit fix 2026-06-18 — DO NOT use `.ilike("id", "${shortId}%")` here.
 *  Postgres has no LIKE/ILIKE operator on the `uuid` type; PostgREST
 *  doesn't auto-cast. The query throws `operator does not exist:
 *  uuid ~~* unknown` and every archive email silently fails to resolve.
 *
 *  Instead, bracket on the UUID range that begins with `<shortId>`:
 *    .gte("id", "<short>-0000-0000-0000-000000000000")
 *    .lt ("id", "<short+1>-0000-0000-0000-000000000000")
 *  This uses the primary-key index, no cast, no SQL function needed.
 *
 *  Refuses to return a row when the parent is soft-deleted is also
 *  dropped — the archive-on-write should be tombstone-tolerant so
 *  in-flight replies still land. The READ-side list helper already
 *  filters deleted parents; the attachment download route gates on
 *  parent-deleted separately. (Audit: dropping the filter prevents
 *  silent reply-loss right after a parent is deleted while a thread
 *  is still in flight.) */
export async function resolveSourceShortId(
  kind: ArchiveKind,
  shortId: string
): Promise<{ id: string; name: string } | null> {
  if (!/^[0-9a-f]{8}$/.test(shortId)) return null;
  const range = uuidPrefixRange(shortId);
  if (!range) return null;
  const sb = commercialDb();
  if (kind === "opp") {
    const { data, error } = await sb
      .from("commercial_opportunities")
      .select("id, title")
      .gte("id", range.start)
      .lt("id", range.end)
      .limit(2); // detect prefix collision
    if (error) {
      console.warn("[email-archive/db] resolveOppShortId failed:", error.message);
      return null;
    }
    const rows = (data ?? []) as Array<{ id: string; title: string }>;
    if (rows.length !== 1) return null; // 0 = miss, 2+ = collision (refuse to guess)
    return { id: rows[0].id, name: rows[0].title };
  }
  // kind === "acc"
  const { data, error } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .gte("id", range.start)
    .lt("id", range.end)
    .limit(2);
  if (error) {
    console.warn("[email-archive/db] resolveAccShortId failed:", error.message);
    return null;
  }
  const rows = (data ?? []) as Array<{ id: string; company_name: string }>;
  if (rows.length !== 1) return null;
  return { id: rows[0].id, name: rows[0].company_name };
}

/** Build the half-open UUID range `[start, end)` whose first 8 hex
 *  chars equal `shortId`. Returns null when shortId is "ffffffff"
 *  (no next-prefix exists) — caller falls through. */
function uuidPrefixRange(shortId: string): { start: string; end: string } | null {
  const lower = shortId.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(lower)) return null;
  const start = `${lower}-0000-0000-0000-000000000000`;
  const asNum = parseInt(lower, 16);
  if (asNum >= 0xffffffff) return null; // 1-in-4-billion overflow case
  const nextHex = (asNum + 1).toString(16).padStart(8, "0");
  const end = `${nextHex}-0000-0000-0000-000000000000`;
  return { start, end };
}
