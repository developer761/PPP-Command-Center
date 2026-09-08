import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifySns, fetchAwsCert, type SnsMessage } from "@/lib/messaging/sns-verify";
import { decideInbound, type EumInbound } from "@/lib/messaging/inbound";
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
 * WHAT IT DOES NOT DO. It does not reply. Recording what arrived and deciding
 * what to say back are separate jobs, and keeping them separate means a bug in
 * the second one cannot lose the first. The tick drafts; the gate decides
 * whether a draft may ever leave. This endpoint only ever writes down what
 * happened.
 *
 * STOP IS HANDLED HERE AND NOWHERE LATER. Suppression is written before the
 * conversation is threaded and before the workspace is resolved, because both
 * of those can fail and neither is an excuse. It is keyed on the handset
 * alone: somebody who says stop has said stop to PPP, not to one campaign.
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
      message: `Dropped an inbound SMS: ${decision.reason}`,
      platform: "ppp_cc",
      context: { reason: decision.reason, messageId: envelope.MessageId },
    });
    return NextResponse.json({ ok: true, dropped: decision.reason });
  }

  const sb = db();

  try {
    // 1. Opt-out FIRST. Before threading, before the workspace lookup, before
    //    anything that can fail.
    if (decision.keyword === "opt_out") {
      // A plain insert, not an upsert. The unique index is PARTIAL — one
      // ACTIVE opt-out per number, `WHERE opted_in_at IS NULL` — so it cannot
      // be named as a conflict target, and a duplicate key here means the
      // number is already suppressed, which is the outcome we wanted anyway.
      //
      // The body is stored verbatim because the table asks for it: if an
      // opt-out is ever disputed, "they replied 'Stop.'" is the evidence.
      const { error } = await sb.from("sms_opt_outs").insert({
        phone_e164: decision.from,
        channel: "sms",
        source: "inbound_keyword",
        inbound_body: decision.body,
        opted_out_at: new Date().toISOString(),
      });
      if (error && error.code !== "23505") throw error;
    }
    if (decision.keyword === "opt_in") {
      // Never delete. The schema is explicit about this: START sets
      // opted_in_at so both decisions survive, because a deleted row makes
      // somebody who re-opted-out indistinguishable from somebody who never
      // opted out at all.
      const { error } = await sb.from("sms_opt_outs")
        .update({ opted_in_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("phone_e164", decision.from)
        .is("opted_in_at", null);
      if (error) throw error;
    }

    // 2. Which workspace was texted. Unknown is recorded, not discarded — a
    //    reply to a number we have forgotten about is a real customer and a
    //    real configuration problem.
    const { data: ws } = await sb.from("sms_sub_accounts")
      .select("id").eq("phone_e164", decision.to).maybeSingle();

    // 3. The open conversation on this pair, if there is one.
    let conversationId: string | null = null;
    if (ws?.id) {
      const { data: convo } = await sb.from("sms_conversations")
        .select("id")
        .eq("workspace_id", ws.id)
        .eq("customer_phone", decision.from)
        .neq("state", "ended")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      conversationId = convo?.id ?? null;

      if (!conversationId) {
        const { data: created, error } = await sb.from("sms_conversations").insert({
          workspace_id: ws.id,
          customer_phone: decision.from,
          // Somebody texting a number we own without an open thread is an
          // inbound lead, not an error.
          state: decision.keyword === "opt_out" ? "ended" : "ai_active",
          outcome: decision.keyword === "opt_out" ? "discard" : null,
          first_inbound_at: new Date().toISOString(),
        }).select("id").single();
        if (error) throw error;
        conversationId = created.id;
      }
    }

    // 4. Write the message down. UNIQUE(provider_id) makes an SNS retry a
    //    no-op rather than a duplicate in the thread.
    if (conversationId) {
      const { error } = await sb.from("sms_messages").insert({
        conversation_id: conversationId,
        direction: "inbound",
        channel: "sms",
        body: decision.body,
        provider_id: decision.providerId,
      });
      // 23505 is the retry we expected.
      if (error && error.code !== "23505") throw error;

      await sb.from("sms_conversations").update({
        last_message_at: new Date().toISOString(),
        ...(decision.keyword === "opt_out"
          ? { state: "ended", outcome: "discard", ended_at: new Date().toISOString() }
          : {}),
      }).eq("id", conversationId);
    } else {
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
