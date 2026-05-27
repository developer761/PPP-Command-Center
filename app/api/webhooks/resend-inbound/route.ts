import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Resend inbound webhook — receives every email sent to
 * orders@orders.precisionpaintingplus.net and threads it into
 * inbox_messages.
 *
 *   POST /api/webhooks/resend-inbound
 *   Headers:
 *     svix-id, svix-timestamp, svix-signature  (Resend uses Svix)
 *   Body: JSON payload Resend sends (see https://resend.com/docs/dashboard/inbound)
 *
 * Threading priority:
 *   1. In-Reply-To header matches a known resend_message_id (in
 *      customer_form_tokens or supplier_orders) — most reliable.
 *   2. PO number (PPP-WO{n}-{supplier}-{seq}) appears in the subject —
 *      matches to supplier_orders.po_number.
 *   3. From-email matches a customer_form_tokens.customer_email with
 *      a recent sent timestamp — customer-reply attribution.
 *   4. None of the above → kind='unmatched', goes to the triage bucket.
 *
 * Idempotent — UNIQUE (resend_message_id) prevents double-ingest if Resend
 * retries the webhook. Returns 200 even when threading fails so Resend
 * doesn't keep retrying.
 *
 * Configuration in Resend dashboard:
 *   - Inbound address: orders@orders.precisionpaintingplus.net
 *   - Webhook URL: https://hub.precisionpaintingplus.net/api/webhooks/resend-inbound
 *   - Webhook secret: stored in RESEND_INBOUND_SECRET env var
 */

type ResendInboundPayload = {
  type?: string;
  data?: {
    from?: { email?: string; name?: string };
    to?: Array<{ email?: string; name?: string }> | string[];
    subject?: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    message_id?: string;
    in_reply_to?: string;
    created_at?: string;
  };
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Verify the Svix-style HMAC signature Resend includes on each webhook.
 * Returns true when the signature matches our stored secret. Skips
 * verification (logs a warning) when RESEND_INBOUND_SECRET isn't set so
 * local dev / first-deploy don't hard-fail; production should always have
 * the secret set.
 */
function verifySignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null
): boolean {
  const secret = process.env.RESEND_INBOUND_SECRET;
  if (!secret) {
    // In production this is a hard fail — accepting unsigned posts to a
    // public webhook lets anyone inject fake messages into the inbox. We
    // refuse to validate so the POST is rejected. In dev we warn + accept
    // so local testing works without the env var.
    if (process.env.NODE_ENV === "production") {
      console.error("[resend-inbound] RESEND_INBOUND_SECRET not set in production — refusing to accept unsigned webhooks");
      return false;
    }
    console.warn("[resend-inbound] RESEND_INBOUND_SECRET not set — webhook running UNSIGNED (dev only). Set the env var before going to prod.");
    return true;
  }
  if (!svixId || !svixTimestamp || !svixSignatureHeader) return false;
  // Reject replays: even with a valid signature, refuse webhooks whose
  // svix-timestamp is more than ±5 minutes from now. Without this an
  // attacker who captures a single signed POST (e.g. from logs) could
  // replay it months later and inject the same message body — the UNIQUE
  // constraint on resend_message_id catches duplicates but not crafted
  // collisions, and unmatched-bucket pollution is still annoying.
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds);
  if (skewSeconds > 300) {
    console.warn(`[resend-inbound] rejecting webhook with timestamp skew ${skewSeconds}s (max 300s)`);
    return false;
  }
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  // Svix secret is base64 with a "whsec_" prefix
  const secretClean = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBytes = Buffer.from(secretClean, "base64");
  const expected = createHmac("sha256", secretBytes).update(signedPayload).digest("base64");
  // Svix header is space-separated "v1,sig v1,sig …" — any match wins
  const sigs = svixSignatureHeader.split(" ").map((s) => s.replace(/^v1,/, ""));
  for (const s of sigs) {
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(s);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      // continue trying other sigs
    }
  }
  return false;
}

export async function POST(request: Request) {
  // Read raw body BEFORE JSON-parsing so signature verification is byte-accurate.
  const rawBody = await request.text();
  const headers = request.headers;
  const ok = verifySignature(
    rawBody,
    headers.get("svix-id"),
    headers.get("svix-timestamp"),
    headers.get("svix-signature")
  );
  if (!ok) {
    console.warn("[resend-inbound] signature verification failed");
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: ResendInboundPayload;
  try {
    payload = JSON.parse(rawBody) as ResendInboundPayload;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const data = payload.data;
  if (!data) {
    // Resend sends test pings — return 200 so the dashboard shows "verified"
    return NextResponse.json({ ok: true, ignored: "no_data" });
  }

  const fromEmail = data.from?.email ?? null;
  if (!fromEmail) {
    return NextResponse.json({ ok: true, ignored: "no_from" });
  }
  const fromName = data.from?.name ?? null;
  const toEmail = Array.isArray(data.to)
    ? typeof data.to[0] === "string"
      ? (data.to[0] as string)
      : (data.to[0] as { email?: string })?.email ?? null
    : null;
  const subject = data.subject ?? null;
  const bodyText = data.text ?? null;
  const bodyHtml = data.html ?? null;
  const messageId = data.message_id ?? null;
  const inReplyTo = data.in_reply_to ?? data.headers?.["in-reply-to"] ?? null;

  const sb = adminClient();

  // ── Threading: try the three priority matchers ──
  let kind: "customer_reply" | "supplier_reply" | "unmatched" = "unmatched";
  let linkedToken: string | null = null;
  let linkedOrderId: string | null = null;
  let linkedWorkOrderId: string | null = null;

  // 1. In-Reply-To header matches a known Resend message id?
  // Only matches against supplier_orders.resend_message_id today —
  // customer_form_tokens doesn't capture the invite Resend message-id yet.
  // Customer replies fall through to the email-match path below; once we
  // add a resend_message_id column to customer_form_tokens (migration TBD)
  // we can add a second .eq() lookup here.
  if (inReplyTo) {
    // Strip angle brackets that some clients add
    const replyTo = inReplyTo.replace(/[<>]/g, "").trim();
    const { data: orderRow } = await sb
      .from("supplier_orders")
      .select("id, work_order_id")
      .eq("resend_message_id", replyTo)
      .maybeSingle();
    if (orderRow) {
      kind = "supplier_reply";
      linkedOrderId = orderRow.id;
      linkedWorkOrderId = orderRow.work_order_id;
    }
  }

  // 2. PO number in subject? Format PPP-WO{wo_number}-{supplier_code}-{seq}.
  // Structured regex with three bounded segments (alphanumeric WO, ALPHA-ONLY
  // supplier code, DIGIT-ONLY seq) so the match can't span across two POs
  // when both appear in the same subject. The previous form
  // `/PPP-WO[A-Z0-9_\-]+/` greedily consumed hyphens, letting "PPP-WO123-BM-1
  // and PPP-WO456-SW-2" match as a single bogus PO that threaded to no row.
  if (kind === "unmatched" && subject) {
    const poMatch = subject.match(/PPP-WO[A-Z0-9]+-[A-Z]+-[0-9]+/i);
    if (poMatch) {
      const poNumber = poMatch[0];
      const { data: orderRow } = await sb
        .from("supplier_orders")
        .select("id, work_order_id")
        .eq("po_number", poNumber)
        .maybeSingle();
      if (orderRow) {
        kind = "supplier_reply";
        linkedOrderId = orderRow.id;
        linkedWorkOrderId = orderRow.work_order_id;
      }
    }
  }

  // 3. From-email matches a customer-form recipient? (last-resort heuristic)
  if (kind === "unmatched" && fromEmail) {
    const { data: tokenRow } = await sb
      .from("customer_form_tokens")
      .select("token, work_order_id")
      .eq("customer_email", fromEmail.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tokenRow) {
      kind = "customer_reply";
      linkedToken = tokenRow.token;
      linkedWorkOrderId = tokenRow.work_order_id;
    }
  }

  // ── Insert ──
  const { error: insertErr } = await sb
    .from("inbox_messages")
    .insert({
      kind,
      linked_token: linkedToken,
      linked_order_id: linkedOrderId,
      linked_work_order_id: linkedWorkOrderId,
      from_email: fromEmail.toLowerCase(),
      from_name: fromName,
      to_email: toEmail,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      resend_message_id: messageId,
      in_reply_to: inReplyTo,
      received_at: data.created_at ?? new Date().toISOString(),
      raw_payload: payload as unknown as Record<string, unknown>,
    });

  if (insertErr) {
    // UNIQUE violation on resend_message_id = duplicate ingest (Resend
    // retried the webhook). Return 200 so it stops retrying.
    if (insertErr.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    console.error("[resend-inbound] insert failed:", insertErr);
    // Return 500 so Resend retries — likely a transient Supabase issue
    return NextResponse.json({ error: "insert_failed", message: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, kind, threaded: kind !== "unmatched" });
}
