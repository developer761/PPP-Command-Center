/**
 * Inbound VOICE on a PPP number: forward it to the call centre.
 *
 * Kate moved this into Iteration 1 on 2026-09-26 — "customers do call the
 * number we're texting them on and we'd want the call forwarded to the call
 * center." Until this existed those calls hit a Twilio number with no voice
 * handling and simply failed.
 *
 * Signed the same way the SMS webhook is, against TWILIO_AUTH_TOKEN. This
 * endpoint is public and it decides where a phone call goes, so an unsigned
 * request is somebody pretending to be Twilio.
 *
 * ── ONE DELIBERATE DIFFERENCE FROM EVERY OTHER ENDPOINT ─────────────────
 *
 * Everywhere else, an unverifiable request is refused. Here a 403 is a
 * customer hearing a failed call, and concluding PPP does not answer its
 * phone. So verification failure is reported loudly AND the caller still
 * gets a spoken line pointing at the main number. Nothing is written and no
 * customer data is read on that path — the worst a forged request achieves
 * is hearing a public phone number read aloud.
 */
import { NextResponse } from "next/server";
import { verifyTwilioSignature, formParams, webhookUrl } from "@/lib/messaging/twilio-webhook";
import { messagingDb } from "@/lib/messaging/db";
import { forwardPlan, forwardTwiml } from "@/lib/messaging/voice-forward";
import { reportWarn, reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } });

export async function POST(req: Request) {
  let params: Record<string, string>;
  try {
    params = formParams(new URLSearchParams(await req.text()));
  } catch {
    return xml(forwardTwiml({ kind: "no_destination" }));
  }

  const url = webhookUrl({
    configured: process.env.TWILIO_VOICE_WEBHOOK_URL,
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
      key: "twilio_voice_unverified", platform: "ppp_cc",
      message: `Rejected an unsigned or badly signed inbound CALL: ${verified.reason}`,
      context: { reason: verified.reason, url, callSid: params.CallSid },
    });
    // Deliberately NOT a 403 — see the header. Nothing is read or written.
    return xml(forwardTwiml({ kind: "no_destination" }));
  }

  // `To` is OUR number, the one they dialled. `From` is the customer.
  const to = (params.To ?? "").trim();
  const from = (params.From ?? "").trim();

  try {
    const { data } = await messagingDb()
      .from("sms_sub_accounts")
      .select("id, name, call_forward_to")
      .eq("phone_e164", to)
      .eq("is_active", true)
      .limit(1);
    const ws = data?.[0];

    const plan = forwardPlan({
      forwardTo: ws?.call_forward_to ?? null,
      known: Boolean(ws),
      // The call centre sees the CUSTOMER's number, so the agent knows who is
      // calling and can ring back. Showing ours would make every call look
      // like it came from the campaign line.
      callerId: from || null,
    });

    if (plan.kind === "no_destination") {
      reportWarn({
        key: "twilio_voice_unknown_number", platform: "ppp_cc",
        message: `A call came in on ${to}, which matches no active workspace`,
        context: { to, callSid: params.CallSid },
      });
    }
    return xml(forwardTwiml(plan));
  } catch (err) {
    // A database blip must not drop a live call.
    reportError({
      key: "twilio_voice_failed", platform: "ppp_cc",
      message: err instanceof Error ? err.message : String(err),
      context: { to, callSid: params.CallSid },
    });
    return xml(forwardTwiml({ kind: "dial", to: "+18776453563", callerId: from || null }));
  }
}
