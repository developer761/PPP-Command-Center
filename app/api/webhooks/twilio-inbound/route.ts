import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { decideInbound } from "@/lib/messaging/inbound";
import { recordInbound } from "@/lib/messaging/record-inbound";
import {
  verifyTwilioSignature, formParams, twilioToInbound, webhookUrl,
} from "@/lib/messaging/twilio-webhook";
import { reportError, reportWarn } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Inbound SMS from Twilio.
 *
 *   POST /api/webhooks/twilio-inbound
 *
 * The same job as the AWS endpoint next door, and deliberately the same code
 * underneath: decideInbound decides, recordInbound writes. Only the envelope
 * differs — form-encoded rather than an SNS JSON wrapper, signed with an HMAC
 * rather than a certificate.
 *
 * TWILIO DOES NOT RETRY AN INBOUND WEBHOOK. That is the one real difference
 * from SNS, and it matters: SNS redelivers a 500 for hours, so a transient
 * database blip there costs nothing. Here it loses the message — including,
 * potentially, a STOP. Two things follow.
 *
 *   The write is retried HERE, briefly, before giving up. Three attempts over
 *   about a second is enough for a connection blip and short enough that
 *   Twilio does not time the request out.
 *
 *   A FALLBACK URL SHOULD BE SET on the number in Twilio's console, pointing
 *   at this same endpoint. Twilio calls it when the primary handler errors,
 *   and it is the only redelivery on offer. Recording is idempotent on
 *   MessageSid, so a fallback that fires after a write that actually succeeded
 *   is a no-op rather than a duplicate.
 *
 * It answers 204 for anything it has durably handled, including a message it
 * decided to drop — there is no reply to make here, because replying is the
 * tick's job and the gate's decision.
 */
function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

const ATTEMPTS = 3;

export async function POST(req: Request) {
  let params: Record<string, string>;
  try {
    // Read as text, not formData(), because the signature is over exactly
    // these bytes and a framework that re-encodes them breaks verification.
    params = formParams(new URLSearchParams(await req.text()));
  } catch {
    return NextResponse.json({ error: "body is not form-encoded" }, { status: 400 });
  }

  const url = webhookUrl({
    configured: process.env.TWILIO_WEBHOOK_URL,
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
    // Unsigned or badly signed traffic is somebody pretending to be a
    // customer. 403, and loud, because this endpoint is public.
    reportWarn({
      key: "twilio_inbound_unverified",
      message: `Rejected an unsigned or badly signed inbound SMS: ${verified.reason}`,
      platform: "ppp_cc",
      // The URL is in here because a mismatch between what Twilio called and
      // what we rebuilt is by far the likeliest cause, and it is the one thing
      // that cannot be worked out from the outside.
      context: { reason: verified.reason, url, messageSid: params.MessageSid },
    });
    return NextResponse.json({ error: "not verified" }, { status: 403 });
  }

  const decision = decideInbound(twilioToInbound(params));
  if (decision.kind === "reject") {
    reportWarn({
      key: "twilio_inbound_dropped",
      // The CODE, not the reason. The reason names the offending number, and
      // this goes to Slack — a customer's handset does not belong in a chat
      // channel.
      message: `Dropped an inbound SMS: ${decision.code}`,
      platform: "ppp_cc",
      context: { code: decision.code, messageSid: params.MessageSid },
    });
    return new NextResponse(null, { status: 204 });
  }

  const sb = db();
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const { conversationId, unknownNumber } = await recordInbound(sb, decision);

      if (unknownNumber) {
        reportWarn({
          key: "twilio_inbound_unknown_number",
          message: `A customer texted ${decision.to} and no workspace owns that number`,
          platform: "ppp_cc",
          context: { to: decision.to, messageSid: params.MessageSid },
        });
      }
      if (attempt > 1) {
        reportWarn({
          key: "twilio_inbound_recovered",
          message: `Recorded an inbound SMS on attempt ${attempt}`,
          platform: "ppp_cc",
          context: { attempt, conversationId },
        });
      }
      return new NextResponse(null, { status: 204 });
    } catch (err) {
      lastError = err;
      // Linear, short. Twilio gives the handler ten seconds before it treats
      // the request as failed, and a long backoff here spends that budget
      // instead of the fallback URL doing its job.
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  reportError({
    key: "twilio_inbound_write_failed",
    message: `Failed to record an inbound SMS after ${ATTEMPTS} attempts — Twilio will NOT retry, only the fallback URL can`,
    platform: "ppp_cc",
    context: {
      error: lastError instanceof Error ? lastError.message : String(lastError),
      messageSid: params.MessageSid,
      wasOptOut: decision.keyword === "opt_out",
    },
  });
  return NextResponse.json({ error: "could not record" }, { status: 500 });
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
