import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import {
  parseArchiveRecipient,
  verifyArchiveHmac,
  extractEmail,
  type ArchiveKind,
} from "./address";
import { resolveSourceShortId } from "./db";
import { sanitizeEmailHtml, htmlToPlainText } from "./sanitize";

/**
 * Inbound handler for archive-tagged emails. Called from
 * app/api/webhooks/resend-inbound after the Resend Svix signature is
 * already verified.
 *
 * Responsibilities:
 *   1. Walk every recipient (To + Cc + Bcc) — Resend exposes Bcc when
 *      the inbound address is the BCC'd one.
 *   2. For each recipient that matches the archive shape, verify the
 *      HMAC against the looked-up full source UUID.
 *   3. For each verified (kind, source) pair, store one row + upload
 *      attachments. Dedup is enforced by the UNIQUE INDEX
 *      (source_kind, source_id, message_id) — a duplicate webhook
 *      retry resolves to "already archived, no-op."
 *
 * Returns { ok, matched: [{kind, source_id}], skipped, errors } so the
 * webhook can log + respond with useful diagnostics.
 */

export type InboundPayload = {
  from?: { email?: string; name?: string };
  to?: Array<{ email?: string }> | string[];
  cc?: Array<{ email?: string }> | string[];
  bcc?: Array<{ email?: string }> | string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  message_id?: string;
  in_reply_to?: string;
  created_at?: string;
  attachments?: Array<{
    filename?: string;
    content_type?: string;
    content?: string; // base64
    size?: number;
  }>;
};

type Match = { kind: ArchiveKind; sourceId: string; sourceName: string };

const PPP_DOMAINS = ["precisionpaintingplus.com", "precisionpaintingplus.net"];
const MAX_BODY_BYTES = 200 * 1024; // 200 KB
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB (Resend's hard cap)
const STORAGE_BUCKET = "commercial-email-attachments";

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Flatten the recipient arrays Resend can return in either shape +
 *  strip display-name + angle-bracket wrappers via extractEmail so
 *  `"Alex" <a@b>` parses correctly. */
function recipientEmails(
  list: Array<{ email?: string }> | string[] | undefined
): string[] {
  if (!list) return [];
  return list
    .map((r) => (typeof r === "string" ? r : r?.email ?? null))
    .filter((s): s is string => !!s)
    .map((s) => extractEmail(s))
    .filter((s) => s.length > 0);
}

/** Sender on a PPP domain? Used for the classification badge. */
function classifySender(
  fromEmail: string,
  headers: Record<string, string> | undefined,
  subject: string | null
): "internal" | "external" | "system" {
  // Bounce / auto-reply detection — handles Outlook OOF, Gmail vacation,
  // mailer-daemon postmaster bounces, generic auto-responders.
  const h = headers ?? {};
  const autoSubmitted = (h["auto-submitted"] ?? h["Auto-Submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return "system";
  const precedence = (h["precedence"] ?? h["Precedence"] ?? "").toLowerCase();
  if (["bulk", "auto_reply", "junk", "list"].includes(precedence)) return "system";
  const autoSuppress = (h["x-auto-response-suppress"] ?? h["X-Auto-Response-Suppress"] ?? "").toLowerCase();
  if (autoSuppress) return "system";
  const subj = (subject ?? "").toLowerCase();
  if (
    subj.startsWith("auto-reply:") ||
    subj.startsWith("auto reply:") ||
    subj.startsWith("automatic reply:") ||
    subj.startsWith("out of office") ||
    subj.startsWith("ooo:") ||
    subj.startsWith("delivery status notification") ||
    subj.startsWith("undeliverable:") ||
    subj.startsWith("mail delivery failed") ||
    /\bvacation\b/.test(subj.split(":")[0] ?? "")
  ) {
    return "system";
  }
  // Internal vs external by sender domain.
  const at = fromEmail.indexOf("@");
  if (at < 0) return "external";
  const domain = fromEmail.slice(at + 1).toLowerCase();
  return PPP_DOMAINS.includes(domain) ? "internal" : "external";
}

/** Truncate a string to maxBytes (UTF-8 safe — count by code units to
 *  keep it simple; the budget is generous enough that 4-byte chars don't
 *  meaningfully overshoot). Returns { value, truncated }. */
function clamp(s: string | null, maxBytes: number): { value: string | null; truncated: boolean } {
  if (s == null) return { value: null, truncated: false };
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { value: s, truncated: false };
  // Slice + decode safely — if the cut lands mid-codepoint, walk back.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { value: buf.slice(0, end).toString("utf8"), truncated: true };
}

/**
 * Try to extract a Message-ID from the Resend payload. Resend usually
 * provides `message_id` directly; fall back to the headers map; fall
 * back to a content-hash so a missing Message-ID doesn't break dedup.
 */
function extractMessageId(p: InboundPayload, fromEmail: string): string {
  const direct = p.message_id?.trim();
  if (direct) return direct.replace(/[<>]/g, "");
  const fromHeaders = p.headers?.["message-id"] ?? p.headers?.["Message-ID"];
  if (fromHeaders) return fromHeaders.trim().replace(/[<>]/g, "");
  // Last resort: stable hash of (from + subject + created_at + first 500
  // chars of body). Same email retried by Resend → same hash → dedup.
  const seed = `${fromEmail}|${p.subject ?? ""}|${p.created_at ?? ""}|${(p.text ?? "").slice(0, 500)}`;
  const { createHash } = require("crypto") as typeof import("crypto");
  return `hash-${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

export type InboundResult = {
  ok: boolean;
  matched: Array<{ kind: ArchiveKind; source_id: string; archived_id: string | null }>;
  skipped: Array<{ recipient: string; reason: string }>;
  errors: string[];
};

/**
 * Walk every recipient, find archive matches, store one row per match.
 *
 * IMPORTANT: this is called AFTER signature verification by the webhook
 * handler. Don't call from anywhere else.
 */
export async function processInboundArchive(
  payload: InboundPayload
): Promise<InboundResult> {
  const out: InboundResult = { ok: true, matched: [], skipped: [], errors: [] };

  const fromEmail = (payload.from?.email ?? "").toLowerCase().trim();
  if (!fromEmail) {
    out.ok = false;
    out.errors.push("no_from_email");
    return out;
  }
  const fromName = payload.from?.name ?? null;
  const toEmails = recipientEmails(payload.to);
  const ccEmails = recipientEmails(payload.cc);
  const bccEmails = recipientEmails(payload.bcc);
  const allRecipients = [...toEmails, ...ccEmails, ...bccEmails];

  // Find every recipient that parses as an archive address. We collect
  // ALL matches up front (an email can BCC opp X AND acc Y) and dedup
  // by (kind, source_id) so a typo'd duplicate doesn't double-store.
  const matches = new Map<string, Match>(); // key = kind:source_id
  for (const recipient of allRecipients) {
    const parsed = parseArchiveRecipient(recipient);
    if (!parsed) continue; // not an archive address — skip silently
    const resolved = await resolveSourceShortId(parsed.kind, parsed.shortId);
    if (!resolved) {
      out.skipped.push({ recipient, reason: "source_not_found_or_deleted" });
      continue;
    }
    if (!verifyArchiveHmac(recipient, resolved.id)) {
      out.skipped.push({ recipient, reason: "hmac_mismatch" });
      continue;
    }
    const key = `${parsed.kind}:${resolved.id}`;
    if (!matches.has(key)) {
      matches.set(key, {
        kind: parsed.kind,
        sourceId: resolved.id,
        sourceName: resolved.name,
      });
    }
  }

  if (matches.size === 0) {
    // Not an archive email — let the webhook fall through to its
    // existing customer-form / supplier handling.
    return out;
  }

  // Build the shared row payload up front (same body / subject / etc
  // across every (kind, source) match).
  const subject = payload.subject ?? null;
  const messageId = extractMessageId(payload, fromEmail);
  const inReplyTo = (payload.in_reply_to ?? payload.headers?.["in-reply-to"] ?? null)
    ?.toString()
    ?.replace(/[<>]/g, "")
    ?.trim() || null;
  const receivedAt = payload.created_at ?? new Date().toISOString();
  const classification = classifySender(fromEmail, payload.headers, subject);

  // Body handling — prefer text, fall back to extracting from HTML.
  const bodyTextRaw = payload.text ?? (payload.html ? htmlToPlainText(payload.html) : null);
  const bodyText = clamp(bodyTextRaw, MAX_BODY_BYTES);
  const bodyHtmlSanitized = payload.html ? sanitizeEmailHtml(payload.html) : null;
  const bodyHtml = clamp(bodyHtmlSanitized, MAX_BODY_BYTES);
  const bodyTruncated = bodyText.truncated || bodyHtml.truncated;

  const sb = adminClient();

  // For each match, upload attachments + insert the row. Storage uploads
  // go FIRST so a failed insert doesn't strand storage objects (we delete
  // them on row-insert failure). Each match gets its own attachment copy
  // — Storage cost is negligible vs. the read-time complexity of sharing.
  for (const match of matches.values()) {
    try {
      const archivedId = (globalThis.crypto?.randomUUID?.() ?? newUuid());
      const attachmentsMeta = await uploadAttachments(
        sb,
        match.kind,
        match.sourceId,
        archivedId,
        payload.attachments ?? []
      );

      const { error: insertErr } = await sb.from("commercial_archived_emails").insert({
        id: archivedId,
        source_kind: match.kind,
        source_id: match.sourceId,
        message_id: messageId,
        in_reply_to: inReplyTo,
        from_email: fromEmail,
        from_name: fromName,
        to_emails: toEmails,
        cc_emails: ccEmails,
        bcc_emails: bccEmails,
        subject,
        body_text: bodyText.value,
        body_html: bodyHtml.value,
        body_truncated: bodyTruncated,
        attachments: attachmentsMeta,
        classification,
        raw_payload: payload as unknown as Record<string, unknown>,
        received_at: receivedAt,
      });
      if (insertErr) {
        if (insertErr.code === "23505") {
          // UNIQUE violation = already archived this (source, message_id).
          // Clean up the orphan storage uploads we just made — they're
          // duplicates of what already exists.
          await cleanupStorageObjects(
            sb,
            attachmentsMeta.map((a) => a.storage_key)
          );
          out.skipped.push({
            recipient: `${match.kind}:${match.sourceId.slice(0, 8)}`,
            reason: "duplicate_dedup",
          });
          continue;
        }
        // Other errors — log + cleanup + record but don't abort the loop.
        await cleanupStorageObjects(
          sb,
          attachmentsMeta.map((a) => a.storage_key)
        );
        out.errors.push(
          `insert failed for ${match.kind}:${match.sourceId.slice(0, 8)}: ${insertErr.message}`
        );
        out.matched.push({ kind: match.kind, source_id: match.sourceId, archived_id: null });
        continue;
      }
      out.matched.push({
        kind: match.kind,
        source_id: match.sourceId,
        archived_id: archivedId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.errors.push(`unexpected for ${match.kind}:${match.sourceId.slice(0, 8)}: ${msg}`);
      out.matched.push({ kind: match.kind, source_id: match.sourceId, archived_id: null });
    }
  }

  if (out.errors.length > 0) out.ok = false;
  return out;
}

type SupabaseAdmin = ReturnType<typeof adminClient>;

/** Upload every Resend-provided attachment to Storage. Returns the
 *  metadata JSON we store on the row. Skips attachments larger than
 *  MAX_ATTACHMENT_BYTES (Resend's own cap is 25 MB but defense in
 *  depth). Filename sanitized to prevent path traversal. */
async function uploadAttachments(
  sb: SupabaseAdmin,
  kind: ArchiveKind,
  sourceId: string,
  archivedId: string,
  attachments: NonNullable<InboundPayload["attachments"]>
): Promise<
  Array<{ filename: string; size_bytes: number; mime_type: string; storage_key: string }>
> {
  const out: Array<{
    filename: string;
    size_bytes: number;
    mime_type: string;
    storage_key: string;
  }> = [];
  if (!attachments || attachments.length === 0) return out;
  for (const a of attachments) {
    if (!a?.content) continue;
    const safeName = sanitizeFileName(a.filename ?? "attachment");
    const mime = a.content_type ?? "application/octet-stream";
    const buf = Buffer.from(a.content, "base64");
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `[email-archive/inbound] skipping oversize attachment (${buf.length}B): ${safeName}`
      );
      continue;
    }
    const storageKey = `emails/${kind}/${sourceId}/${archivedId}/${safeName}`;
    const up = await sb.storage.from(STORAGE_BUCKET).upload(storageKey, buf, {
      contentType: mime,
      upsert: false,
    });
    if (up.error) {
      console.warn(`[email-archive/inbound] storage upload failed for ${safeName}:`, up.error.message);
      continue; // skip this attachment but don't tank the whole row
    }
    out.push({
      filename: safeName,
      size_bytes: buf.length,
      mime_type: mime,
      storage_key: storageKey,
    });
  }
  return out;
}

async function cleanupStorageObjects(sb: SupabaseAdmin, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await sb.storage.from(STORAGE_BUCKET).remove(keys).catch((err) => {
    console.warn("[email-archive/inbound] storage cleanup failed:", err);
  });
}

/** Path-safe filename: lowercase + alphanumeric + . - _ only + clamp. */
function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || "attachment"
  );
}

/** Tiny fallback when globalThis.crypto.randomUUID isn't available. */
function newUuid(): string {
  const { randomUUID } = require("crypto") as typeof import("crypto");
  return randomUUID();
}
