/**
 * Writing down a message a customer sent us.
 *
 * Lifted out of app/api/webhooks/sms-inbound/route.ts unchanged when Twilio
 * became a second way the same message can arrive. Two carriers posting to two
 * endpoints must not mean two copies of this: the opt-out insert that tolerates
 * a 23505, the threading, the "do not queue a second turn for a redelivery"
 * rule and the two different waits are all subtle, all load-bearing, and a
 * second copy would drift from this one the first time either was touched.
 * verify-inbound-e2e.mjs had already grown exactly that kind of copy.
 *
 * DECIDES NOTHING. decideInbound decided; this writes. It does not reply —
 * recording what arrived and working out what to say back are separate jobs,
 * and keeping them apart means a bug in the second cannot lose the first.
 *
 * Throws on a write it could not complete, so the caller can answer its own
 * carrier in the way that carrier understands.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundDecision } from "./inbound";
import { reportWarn } from "@/lib/observability";
import { replyDueAt, TURN_START_SECONDS } from "./reply-delay";

export type Accepted = Extract<InboundDecision, { kind: "accept" }>;

/**
 * A Supabase error is a plain object, not an Error.
 *
 * Throwing it raw meant every caller's `err instanceof Error ? err.message :
 * String(err)` produced the string "[object Object]" — which is what the
 * route was sending to Slack, and what verify-inbound-e2e printed instead of
 * naming the constraint that actually failed. The code and the details are
 * the whole diagnosis, so they go in the message.
 */
function asError(where: string, e: { message?: string; code?: string; details?: string; hint?: string }): Error {
  const parts = [e.message, e.code && `code ${e.code}`, e.details, e.hint].filter(Boolean);
  return new Error(`${where}: ${parts.join(" — ") || "unknown database error"}`);
}

export type RecordedInbound = {
  conversationId: string | null;
  /** True when a customer texted a number no workspace claims. */
  unknownNumber: boolean;
  /** False when the same provider id had already been recorded. */
  isNew: boolean;
};

export async function recordInbound(sb: SupabaseClient, decision: Accepted): Promise<RecordedInbound> {
  // 1. Opt-out FIRST. Before threading, before the workspace lookup, before
  //    anything that can fail.
  if (decision.keyword === "opt_out") {
    // A plain insert, not an upsert. The unique index is PARTIAL — one ACTIVE
    // opt-out per number, `WHERE opted_in_at IS NULL` — so it cannot be named
    // as a conflict target, and a duplicate key here means the number is
    // already suppressed, which is the outcome we wanted anyway.
    //
    // The body is stored verbatim because the table asks for it: if an opt-out
    // is ever disputed, "they replied 'Stop.'" is the evidence.
    const { error } = await sb.from("sms_opt_outs").insert({
      phone_e164: decision.from,
      channel: "sms",
      source: "inbound_keyword",
      inbound_body: decision.body,
      opted_out_at: new Date().toISOString(),
    });
    if (error && error.code !== "23505") throw asError("recording the opt-out", error);
  }
  if (decision.keyword === "opt_in") {
    // Never delete. The schema is explicit about this: START sets opted_in_at
    // so both decisions survive, because a deleted row makes somebody who
    // re-opted-out indistinguishable from somebody who never opted out at all.
    const { error } = await sb.from("sms_opt_outs")
      .update({ opted_in_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("phone_e164", decision.from)
      .is("opted_in_at", null);
    if (error) throw asError("recording the opt-in", error);
  }

  // 2. Which workspace was texted. Unknown is recorded, not discarded — a
  //    reply to a number we have forgotten about is a real customer and a real
  //    configuration problem.
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, autosend_enabled, time_zone, quiet_hours_start, quiet_hours_end, reply_delay_min_seconds, reply_delay_max_seconds")
    .eq("phone_e164", decision.to).maybeSingle();

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
        // ended_at, NOT just outcome. sms_conversations_ended_shape demands
        // all three together, and this insert set only two — so a STOP from
        // somebody with no open conversation (a second STOP, or a number that
        // opted out long ago) violated the constraint and the webhook answered
        // 500. SNS then retried that same message for hours, failing every
        // time. Found the moment verify-inbound-e2e started running this code
        // instead of its own copy, which had quietly skipped the whole path.
        ended_at: decision.keyword === "opt_out" ? new Date().toISOString() : null,
        first_inbound_at: new Date().toISOString(),
      }).select("id").single();
      if (error) throw asError("opening a conversation", error);
      conversationId = created.id;
    }
  }

  // 4. Write the message down. UNIQUE(provider_id) makes a redelivery a no-op
  //    rather than a duplicate in the thread.
  let isNew = true;
  if (conversationId) {
    const { error } = await sb.from("sms_messages").insert({
      conversation_id: conversationId,
      direction: "inbound",
      channel: "sms",
      body: decision.body,
      provider_id: decision.providerId,
    });
    // 23505 is the redelivery we expected.
    if (error && error.code !== "23505") throw asError("writing the inbound message", error);
    isNew = error?.code !== "23505";
    const receivedAt = new Date();

    // Queue a reply, unless they just told us to stop.
    //
    // Enqueued rather than generated here on purpose: asking a model takes
    // seconds, a webhook that times out gets redelivered, and that would
    // produce a second draft for the same message. The tick picks this up, and
    // the unique index on one pending draft per conversation is the backstop
    // if it somehow runs twice.
    if (isNew && decision.keyword !== "opt_out" && decision.keyword !== "help") {
      // TWO DIFFERENT WAITS, and they are not the same thing.
      //
      // When the turn STARTS: TURN_START_SECONDS after the text, fixed. A
      // customer sending three texts in a row gets one answer to all three.
      //
      // When the reply ARRIVES: reply_due_at, drawn from the workspace's range
      // (30-90 seconds by default), counted from this message. The turn writes
      // the reply and holds it until then. That applies only where Emily sends
      // on her own; where a person approves each reply the customer already
      // waits for review.
      const dueAt = ws?.autosend_enabled
        ? replyDueAt({
            receivedAt,
            config: {
              minSeconds: ws?.reply_delay_min_seconds ?? 0,
              maxSeconds: ws?.reply_delay_max_seconds ?? 0,
            },
            timeZone: ws?.time_zone ?? "America/New_York",
            quietHours: {
              startHour: ws?.quiet_hours_start ?? 9,
              endHour: ws?.quiet_hours_end ?? 20,
            },
          })
        : null;

      const { error: qErr } = await sb.from("sms_scheduled_actions").insert({
        conversation_id: conversationId,
        action: "agent_turn",
        run_at: new Date(receivedAt.getTime() + TURN_START_SECONDS * 1000).toISOString(),
        reply_due_at: dueAt?.toISOString() ?? null,
      });
      if (qErr) {
        reportWarn({
          key: "sms_inbound_queue_failed",
          message: "Recorded an inbound SMS but could not queue a reply",
          platform: "ppp_cc",
          context: { conversationId, error: qErr.message },
        });
      }
    }

    await sb.from("sms_conversations").update({
      last_message_at: new Date().toISOString(),
      ...(decision.keyword === "opt_out"
        ? { state: "ended", outcome: "discard", ended_at: new Date().toISOString() }
        : {}),
    }).eq("id", conversationId);
  }

  return { conversationId, unknownNumber: !ws?.id, isNew };
}
