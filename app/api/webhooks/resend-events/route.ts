import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Resend lifecycle-events webhook — listens for every event Resend emits
 * about emails the Command Center has sent OUT. Updates the originating
 * row's delivery_status so the Mail Hub's Sent view can show "Delivered
 * to BM at 2:14pm" / "⚠ Bounced — re-send" / "Customer opened the email
 * at 3:42pm" instead of just "sent."
 *
 *   POST /api/webhooks/resend-events
 *   Headers: svix-id, svix-timestamp, svix-signature (Resend uses Svix)
 *   Body: JSON event payload from Resend (https://resend.com/docs/webhooks)
 *
 * Events we care about:
 *   - email.delivered   → status='delivered'
 *   - email.bounced     → status='bounced'  (hard bounce, won't retry)
 *   - email.complained  → status='complained' (spam report)
 *   - email.opened      → status='opened' (informational)
 *   - email.clicked     → status='clicked' (informational)
 *   - email.delivery_delayed → status='delayed' (soft bounce, will retry)
 *
 * Threading by data.email_id (Resend's message id) against:
 *   - customer_form_tokens.resend_message_id_invite
 *   - supplier_orders.resend_message_id
 *
 * Always returns 200 so Resend doesn't retry — failures are logged for
 * debugging but don't block the webhook.
 *
 * Configuration in Resend dashboard:
 *   - Webhook URL: https://hub.precisionpaintingplus.net/api/webhooks/resend-events
 *   - Events: tick all (delivered, bounced, complained, opened, clicked, delayed)
 *   - Secret: stored in RESEND_EVENTS_SECRET env var (separate from inbound)
 */

type ResendEventPayload = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    bounce?: { type?: string; message?: string };
    click?: { link?: string };
    [k: string]: unknown;
  };
};

function verifySignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignatureHeader: string | null
): boolean {
  // trim so a stray-whitespace env value isn't treated as a (garbage) secret
  // that 401s every real webhook.
  const secret = process.env.RESEND_EVENTS_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[resend-events] RESEND_EVENTS_SECRET not set in production — refusing to accept unsigned webhooks");
      return false;
    }
    console.warn("[resend-events] RESEND_EVENTS_SECRET not set — webhook running UNSIGNED (dev only). Set the env var before going to prod.");
    return true;
  }
  if (!svixId || !svixTimestamp || !svixSignatureHeader) return false;
  // Same ±5min replay window as the inbound webhook
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsSeconds);
  if (skewSeconds > 300) {
    console.warn(`[resend-events] rejecting webhook with timestamp skew ${skewSeconds}s (max 300s)`);
    return false;
  }
  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const secretClean = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBytes = Buffer.from(secretClean, "base64");
  const expected = createHmac("sha256", secretBytes).update(signedPayload).digest("base64");
  const sigs = svixSignatureHeader.split(" ").map((s) => s.replace(/^v1,/, ""));
  for (const s of sigs) {
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(s);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      // continue
    }
  }
  return false;
}

/** Map Resend event type → DB delivery_status value */
function statusForEvent(type: string): string | null {
  switch (type) {
    case "email.sent":             return "sent";
    case "email.delivered":        return "delivered";
    case "email.bounced":          return "bounced";
    case "email.complained":       return "complained";
    case "email.opened":           return "opened";
    case "email.clicked":          return "clicked";
    case "email.delivery_delayed": return "delayed";
    default:                       return null;
  }
}

// Status precedence. Resend does NOT guarantee event ordering — an "opened" or
// "delivered" can arrive AFTER a "bounced"/"complained". A blind overwrite would
// mask a dead address (admin re-trusts it, never re-sends). Higher rank wins;
// terminal-negative statuses sit far above the positives so they stick. Equal-or-
// higher also blocks going backwards within positives (delivered after clicked).
const STATUS_PRIORITY: Record<string, number> = {
  sent: 1, delayed: 2, delivered: 3, opened: 4, clicked: 5,
  bounced: 100, complained: 101, failed: 102,
};
function shouldApplyStatus(current: string | null, next: string): boolean {
  if (!current) return true;
  return (STATUS_PRIORITY[next] ?? 0) >= (STATUS_PRIORITY[current] ?? 0);
}

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(request: Request) {
  // Read raw body BEFORE JSON-parsing for byte-accurate signature verification
  const rawBody = await request.text();
  const headers = request.headers;
  const ok = verifySignature(
    rawBody,
    headers.get("svix-id"),
    headers.get("svix-timestamp"),
    headers.get("svix-signature")
  );
  if (!ok) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: ResendEventPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const eventType = payload.type;
  const emailId = payload.data?.email_id;
  if (!eventType || !emailId) {
    console.warn(`[resend-events] missing type or email_id: ${JSON.stringify(payload).slice(0, 200)}`);
    // Return 200 so Resend doesn't retry — nothing for us to thread
    return NextResponse.json({ ok: true, skipped: "missing_fields" });
  }

  const status = statusForEvent(eventType);
  if (!status) {
    // Unknown event type — log + ack so Resend stops retrying
    console.warn(`[resend-events] unknown event type: ${eventType}`);
    return NextResponse.json({ ok: true, skipped: "unknown_event_type" });
  }

  const sb = adminClient();
  const updatedAt = new Date().toISOString();

  // Look up the matching row in each table by message id, then apply the new
  // status ONLY when it should take precedence (see shouldApplyStatus). A row
  // can live in supplier_orders OR customer_form_tokens; we check both.
  // Read-then-write (not a blind UPDATE) so out-of-order events can't mask a
  // terminal-negative status. Email-event volume here is tiny, so the extra
  // round-trip is irrelevant.
  const [existingOrder, existingToken] = await Promise.all([
    sb.from("supplier_orders").select("id, delivery_status").eq("resend_message_id", emailId).maybeSingle(),
    sb.from("customer_form_tokens").select("token, delivery_status").eq("resend_message_id_invite", emailId).maybeSingle(),
  ]);

  const matchedOrder = !!existingOrder.data;
  const matchedToken = !!existingToken.data;
  let appliedOrder = false;
  let appliedToken = false;

  if (existingOrder.data) {
    if (shouldApplyStatus(existingOrder.data.delivery_status as string | null, status)) {
      const upd = await sb
        .from("supplier_orders")
        .update({ delivery_status: status, delivery_status_updated_at: updatedAt })
        .eq("id", existingOrder.data.id);
      if (upd.error) console.error(`[resend-events] supplier_orders update failed:`, upd.error.message);
      else appliedOrder = true;
    } else {
      console.log(`[resend-events] skip ${status} on order ${existingOrder.data.id} — current "${existingOrder.data.delivery_status}" outranks it`);
    }
  }
  if (existingToken.data) {
    if (shouldApplyStatus(existingToken.data.delivery_status as string | null, status)) {
      const upd = await sb
        .from("customer_form_tokens")
        .update({ delivery_status: status, delivery_status_updated_at: updatedAt })
        .eq("token", existingToken.data.token);
      if (upd.error) console.error(`[resend-events] customer_form_tokens update failed:`, upd.error.message);
      else appliedToken = true;
    } else {
      console.log(`[resend-events] skip ${status} on token — current "${existingToken.data.delivery_status}" outranks it`);
    }
  }
  if (existingOrder.error) {
    console.error(`[resend-events] supplier_orders lookup failed:`, existingOrder.error.message);
  }
  if (existingToken.error) {
    console.error(`[resend-events] customer_form_tokens lookup failed:`, existingToken.error.message);
  }
  if (!matchedOrder && !matchedToken) {
    // Could be a test email (no DB row) or a row created before migration
    // 010 — log + ack. We don't want Resend to retry forever for these.
    console.warn(
      `[resend-events] no match for ${eventType} email_id=${emailId} — likely a test email or pre-migration send`
    );
  }

  return NextResponse.json({
    ok: true,
    eventType,
    emailId,
    status,
    matchedSupplierOrder: matchedOrder,
    matchedCustomerForm: matchedToken,
    appliedSupplierOrder: appliedOrder,
    appliedCustomerForm: appliedToken,
  });
}
