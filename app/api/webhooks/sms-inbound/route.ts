import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifySns, fetchAwsCert, type SnsMessage } from "@/lib/messaging/sns-verify";
import { decideInbound, type EumInbound } from "@/lib/messaging/inbound";
import { recordInbound } from "@/lib/messaging/record-inbound";
import { reportError, reportWarn } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Inbound SMS from AWS End User Messaging, via SNS.
 *
 *   POST /api/webhooks/sms-inbound
 *
 * Without this the agent never sees an answer. Everything downstream of a
 * customer replying — the funnel, adherence, the whole conversation — has been
 * waiting on it.
 *
 * This is the AWS half. Twilio posts to /api/webhooks/twilio-inbound and both
 * hand the same decision to the same recordInbound, so the carrier changes how
 * a message ARRIVES and nothing about what happens to it.
 *
 * WHAT IT DOES NOT DO. It does not reply. Recording what arrived and deciding
 * what to say back are separate jobs, and keeping them separate means a bug in
 * the second one cannot lose the first. The tick drafts; the gate decides
 * whether a draft may ever leave. This endpoint only ever writes down what
 * happened.
 *
 * STOP IS HANDLED FIRST AND NOWHERE LATER — see recordInbound.
 *
 * Returns 200 for anything it has durably handled, INCLUDING a message it
 * decided to drop. SNS retries a non-200 for hours, and re-delivering a
 * malformed payload forever produces noise, not a fix. It returns non-200 only
 * when the failure is ours and retrying could genuinely work.
 */
function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(req: Request) {
  let envelope: SnsMessage;
  try {
    envelope = (await req.json()) as SnsMessage;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const verified = await verifySns(envelope, fetchAwsCert);
  if (!verified.ok) {
    // Unsigned or badly signed traffic is somebody pretending to be a
    // customer. 403, and loud, because this endpoint is public.
    reportWarn({
      key: "sms_inbound_unverified",
      message: `Rejected an unsigned or badly signed inbound SMS: ${verified.reason}`,
      platform: "ppp_cc",
      context: { reason: verified.reason, messageId: envelope.MessageId },
    });
    return NextResponse.json({ error: "not verified" }, { status: 403 });
  }

  // AWS confirms a subscription by asking us to visit a URL it signed. Doing
  // it automatically is safe ONLY because the signature was checked first —
  // otherwise anyone could subscribe us to their topic.
  if (envelope.Type === "SubscriptionConfirmation" && envelope.SubscribeURL) {
    try {
      await fetch(envelope.SubscribeURL);
      return NextResponse.json({ ok: true, confirmed: true });
    } catch (err) {
      reportError({
        key: "sms_inbound_subscribe_failed",
        message: "Could not confirm the SNS subscription for inbound SMS",
        platform: "ppp_cc",
        context: { error: err instanceof Error ? err.message : String(err) },
      });
      return NextResponse.json({ error: "confirmation failed" }, { status: 500 });
    }
  }

  if (envelope.Type !== "Notification") {
    return NextResponse.json({ ok: true, ignored: envelope.Type });
  }

  let payload: EumInbound;
  try {
    payload = JSON.parse(envelope.Message ?? "{}") as EumInbound;
  } catch {
    reportWarn({
      key: "sms_inbound_unparseable",
      message: "Inbound SMS notification body was not JSON",
      platform: "ppp_cc",
      context: { messageId: envelope.MessageId },
    });
    return NextResponse.json({ ok: true, dropped: "unparseable" });
  }

  const decision = decideInbound(payload);
  if (decision.kind === "reject") {
    reportWarn({
      key: "sms_inbound_dropped",
      // The CODE, not the reason. The reason names the offending number, and
      // this goes to Slack — a customer's handset does not belong in a chat
      // channel. The full reason still goes back to AWS in the response.
      message: `Dropped an inbound SMS: ${decision.code}`,
      platform: "ppp_cc",
      context: { code: decision.code, messageId: envelope.MessageId },
    });
    return NextResponse.json({ ok: true, dropped: decision.reason });
  }

  try {
    const { conversationId, unknownNumber } = await recordInbound(db(), decision);

    if (unknownNumber) {
      reportWarn({
        key: "sms_inbound_unknown_number",
        message: `A customer texted ${decision.to} and no workspace owns that number`,
        platform: "ppp_cc",
        context: { to: decision.to, messageId: envelope.MessageId },
      });
    }

    return NextResponse.json({
      ok: true,
      keyword: decision.keyword,
      threaded: !!conversationId,
      media: decision.mediaCount,
    });
  } catch (err) {
    // Ours, and a retry might work — so let SNS retry.
    reportError({
      key: "sms_inbound_write_failed",
      message: "Failed to record an inbound SMS — SNS will retry",
      platform: "ppp_cc",
      context: { error: err instanceof Error ? err.message : String(err), messageId: envelope.MessageId },
    });
    return NextResponse.json({ error: "could not record" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
