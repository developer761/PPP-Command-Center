import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  verifyTwilioSignature, formParams, webhookUrl,
} from "@/lib/messaging/twilio-webhook";
import { statusFromTwilio, shouldApply, isFailure, failureNote } from "@/lib/messaging/delivery";
import { reportWarn } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * What happened to a message after Twilio accepted it.
 *
 *   POST /api/webhooks/twilio-status
 *
 * delivery_status was written once as "sent" and never updated, so a message
 * the carrier filtered or could not deliver looked exactly like one that
 * arrived — on the thread, in the reports, everywhere, forever.
 *
 * This matters most in the weeks right after the port. The likeliest failure
 * on a fresh 10DLC campaign is carrier FILTERING: Twilio accepts the message,
 * bills for it, and a carrier drops it before the handset. Error 30007. There
 * is no other signal — delivery simply falls off, and without this endpoint
 * nobody would know until somebody noticed the leads had gone quiet.
 *
 * Signed the same way inbound messages are, and refused the same way. A status
 * callback is less dangerous to forge than an inbound STOP, but forging
 * "delivered" on messages that failed would hide exactly what this exists to
 * show.
 */
function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(req: Request) {
  let params: Record<string, string>;
  try {
    params = formParams(new URLSearchParams(await req.text()));
  } catch {
    return NextResponse.json({ error: "body is not form-encoded" }, { status: 400 });
  }

  const url = webhookUrl({
    configured: process.env.TWILIO_STATUS_WEBHOOK_URL,
    requestUrl: req.url,
    forwardedProto: req.headers.get("x-forwarded-proto"),
    forwardedHost: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  });

  const verified = verifyTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    url,
    params,
    signature: req.headers.get("x-twilio-signature"),
  });
  if (!verified.ok) {
    reportWarn({
      key: "twilio_status_unverified",
      message: `Rejected an unsigned or badly signed status callback: ${verified.reason}`,
      platform: "ppp_cc",
      context: { reason: verified.reason, url, messageSid: params.MessageSid },
    });
    return NextResponse.json({ error: "not verified" }, { status: 403 });
  }

  const sid = params.MessageSid || params.SmsSid;
  const status = statusFromTwilio(params.MessageStatus || params.SmsStatus);
  // An unknown status is left alone rather than guessed at.
  if (!sid || !status) return new NextResponse(null, { status: 204 });

  const sb = db();

  // provider_id is what ties a callback to a message. It carries a UNIQUE
  // index, so this identifies exactly one row or none.
  const { data: msg } = await sb.from("sms_messages")
    .select("id, conversation_id, delivery_status")
    .eq("provider_id", sid).maybeSingle();
  // Not ours, or not recorded yet. 204 either way: Twilio retries a non-2xx
  // and there is nothing a retry would fix.
  if (!msg) return new NextResponse(null, { status: 204 });

  // Callbacks are not ordered and Twilio retries them, so a late "sent" can
  // arrive after "delivered" and must not un-deliver a message that landed.
  if (!shouldApply(msg.delivery_status, status)) {
    return new NextResponse(null, { status: 204 });
  }

  const code = params.ErrorCode ? Number.parseInt(params.ErrorCode, 10) : null;
  const note = isFailure(status)
    ? failureNote(Number.isFinite(code) ? code : null, params.ErrorMessage ?? null)
    : null;

  const { error } = await sb.from("sms_messages")
    .update({ delivery_status: status, ...(note ? { failure_reason: note } : {}) })
    .eq("id", msg.id);
  if (error) {
    // Worth a retry: Twilio will call again on a non-2xx.
    return NextResponse.json({ error: "could not record" }, { status: 500 });
  }

  if (isFailure(status)) {
    // LOUD. A message that never arrived is the thing this endpoint exists to
    // surface, and a silent row in a table nobody opens is not surfacing it.
    // The customer's number is deliberately absent — this goes to Slack.
    reportWarn({
      key: "sms_delivery_failed",
      message: `A message was not delivered (${status}): ${note}`,
      platform: "ppp_cc",
      context: { status, code, conversationId: msg.conversation_id, messageSid: sid },
    });
  }

  return new NextResponse(null, { status: 204 });
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
