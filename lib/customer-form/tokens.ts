import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

/**
 * Customer-form token lifecycle:
 *
 *   createToken()    — admin clicks "Send Form" → token row inserted, expires in 30d
 *   markSent()       — Resend confirmed delivery → sent_at + delivery_status set
 *   markOpened()     — customer hit /select/[token] for the first time
 *   validateToken()  — every form render + submit checks expiry / supersession
 *   markSubmitted()  — customer hit submit → submitted_at + payload saved
 *
 * Tokens are 32 cryptographically random bytes encoded base64url (~43 chars,
 * unguessable). Shareable URL = https://hub.precisionpaintingplus.net/select/<token>.
 *
 * Customer submits write directly to Salesforce via a separate writeback path
 * (see lib/customer-form/sf-writeback.ts) — that flow logs every SF write to
 * sf_writes_audit for replay + diagnostics.
 */

export type CustomerFormToken = {
  token: string;
  work_order_id: string;
  work_order_number: string | null;
  customer_email: string;
  customer_name: string | null;
  account_id: string | null;
  created_at: string;
  created_by_user_id: string | null;
  expires_at: string;
  sent_at: string | null;
  delivery_status: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  submitted_payload: Record<string, unknown> | null;
  draft_editing_by: string | null;
  draft_editing_until: string | null;
  vendor_email_sent_at: string | null;
  woli_snapshot_at: string | null;
  customer_ip: string | null;
  customer_user_agent: string | null;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Generate a fresh URL-safe random token. 32 bytes → 43 chars base64url. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a new customer-form token row. Returns the token on success so the
 * caller can build the share URL. The actual email send is a separate step
 * (sendCustomerFormEmail in lib/email/resend.ts) — this just persists the
 * token; status flips to "sent" once Resend confirms delivery.
 */
export async function createToken(input: {
  work_order_id: string;
  work_order_number?: string | null;
  customer_email: string;
  customer_name?: string | null;
  account_id?: string | null;
  created_by_user_id?: string | null;
  expiresInDays?: number; // default 30
}): Promise<{ token: string } | { error: string }> {
  const token = generateToken();
  const expiresInDays = input.expiresInDays ?? 30;
  const expires_at = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();

  const sb = adminClient();
  const { error } = await sb.from("customer_form_tokens").insert({
    token,
    work_order_id: input.work_order_id,
    work_order_number: input.work_order_number ?? null,
    customer_email: input.customer_email.toLowerCase().trim(),
    customer_name: input.customer_name ?? null,
    account_id: input.account_id ?? null,
    created_by_user_id: input.created_by_user_id ?? null,
    expires_at,
  });
  if (error) {
    console.error("[customer-form] createToken failed:", error.message);
    return { error: error.message };
  }
  return { token };
}

// Tokens are crypto.randomBytes(32) base64url-encoded → exactly 43 chars
// from a fixed alphabet [A-Za-z0-9_-]. Strict validation here means we never
// hit Supabase for obviously-malformed tokens (typos, scraper bots), reducing
// load AND giving an attacker zero feedback about which formats might be valid.
const VALID_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Look up a token by its string. Returns null when not found / expired. */
export async function getToken(token: string): Promise<CustomerFormToken | null> {
  if (!token || !VALID_TOKEN_PATTERN.test(token)) return null;
  const sb = adminClient();
  const { data, error } = await sb
    .from("customer_form_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) {
    console.error("[customer-form] getToken failed:", error.message);
    return null;
  }
  return (data as CustomerFormToken) ?? null;
}

/**
 * Validate a token for display. Returns one of:
 *   { kind: "ok",         token: CustomerFormToken }
 *   { kind: "expired" }
 *   { kind: "submitted",  token: CustomerFormToken }  // can show "thanks" page
 *   { kind: "not_found" }
 *
 * Caller decides what to render per kind.
 */
export type TokenStatus =
  | { kind: "ok"; token: CustomerFormToken }
  | { kind: "expired" }
  | { kind: "submitted"; token: CustomerFormToken }
  | { kind: "not_found" };

export async function validateToken(token: string): Promise<TokenStatus> {
  const row = await getToken(token);
  if (!row) return { kind: "not_found" };
  if (row.submitted_at) return { kind: "submitted", token: row };
  if (new Date(row.expires_at) < new Date()) return { kind: "expired" };
  return { kind: "ok", token: row };
}

/** Mark Resend delivery confirmed. Called from a webhook (Phase 2 deliverability). */
export async function markSent(
  token: string,
  delivery_status: "delivered" | "bounced" | "soft_bounced" | "spam" = "delivered",
  resendMessageId?: string
): Promise<void> {
  const sb = adminClient();
  const patch: Record<string, unknown> = { delivery_status };
  if (delivery_status === "delivered") patch.sent_at = new Date().toISOString();
  // Stamp the Resend message id so the events webhook can thread future
  // delivery/bounce/open events back to this token. Best-effort — if the
  // column doesn't exist yet (migration 010 not run) the UPDATE silently
  // ignores the unknown key.
  if (resendMessageId) patch.resend_message_id_invite = resendMessageId;
  await sb.from("customer_form_tokens").update(patch).eq("token", token);
}

/**
 * Mark the token as opened by the customer. Idempotent — only updates if
 * opened_at is still null, so we capture the FIRST open timestamp.
 */
export async function markOpened(
  token: string,
  meta?: { ip?: string | null; userAgent?: string | null }
): Promise<void> {
  const sb = adminClient();
  await sb
    .from("customer_form_tokens")
    .update({
      opened_at: new Date().toISOString(),
      customer_ip: meta?.ip ?? null,
      customer_user_agent: meta?.userAgent ?? null,
    })
    .eq("token", token)
    .is("opened_at", null); // only set if not already opened
}

/**
 * Mark the customer-form submission. payload is the full form state.
 *
 * Returns:
 *   { ok: true,  fresh: true  } — this caller IS the first submitter; SF
 *                                 writes should proceed.
 *   { ok: true,  fresh: false } — token was already submitted (concurrent
 *                                 retry or double-click); skip SF writes
 *                                 to avoid duplicate writes that would
 *                                 land twice in the audit log.
 *   { ok: false, error }       — DB write actually failed.
 *
 * The `.is("submitted_at", null)` filter ensures only the FIRST update
 * actually writes (subsequent calls match 0 rows). We use the returned
 * row count via .select() to detect this — previously we returned ok:true
 * for both winner AND loser, which let race losers fire SF writes too
 * (audit-flagged 2026-05-26).
 */
export async function markSubmitted(
  token: string,
  payload: Record<string, unknown>
): Promise<{ ok: true; fresh: boolean } | { ok: false; error: string }> {
  const sb = adminClient();
  const { data, error } = await sb
    .from("customer_form_tokens")
    .update({
      submitted_at: new Date().toISOString(),
      submitted_payload: payload,
    })
    .eq("token", token)
    .is("submitted_at", null) // idempotent — only first submit wins
    .select("token");
  if (error) {
    console.error("[customer-form] markSubmitted failed:", error.message);
    return { ok: false, error: error.message };
  }
  const updatedRows = data?.length ?? 0;
  if (updatedRows === 0) {
    // Token was already submitted — concurrent caller lost the race.
    // Return ok=true so the customer sees a success page (their data
    // was captured on the first attempt), but flag fresh=false so the
    // caller skips SF writes.
    console.warn(`[customer-form] markSubmitted lost-race for token ${token.slice(0, 8)}… (already submitted)`);
    return { ok: true, fresh: false };
  }
  return { ok: true, fresh: true };
}

/**
 * Capture the WOLI snapshot timestamp at form-render time so we can detect
 * if Salesforce data changed between render and submit (rep adding/removing
 * line items, etc.). Used for the "your rep just updated this" conflict
 * warning on submit.
 */
export async function markWoliSnapshotTime(token: string): Promise<void> {
  const sb = adminClient();
  await sb
    .from("customer_form_tokens")
    .update({ woli_snapshot_at: new Date().toISOString() })
    .eq("token", token);
}
