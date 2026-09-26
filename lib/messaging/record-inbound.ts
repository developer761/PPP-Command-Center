import { optOutSource } from "./compliance";
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
import { customerZone } from "./customer-clock";
import { helpReply } from "./help-reply";
import { afterHoursReply, AFTER_HOURS_INTENT } from "./after-hours";
import { trackForWorkspace } from "./track";
import { statedConstraint } from "./reachability";

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
    const row = {
      phone_e164: decision.from,
      channel: "sms",
      inbound_body: decision.body,
      opted_out_at: new Date().toISOString(),
    };
    // A carrier keyword and a sentence are different evidence if an opt-out is
    // ever disputed, so they are not recorded as the same thing.
    const { error } = await sb.from("sms_opt_outs").insert({ ...row, source: optOutSource(decision.body) });

    // THE SUPPRESSION MATTERS MORE THAN THE LABEL ON IT.
    //
    // 'inbound_phrase' needs migration 20260925140000, and this repo has no
    // migration runner — the README says so, and says the app must tolerate a
    // migration being un-applied. Un-applied, that value fails the source
    // CHECK with 23514, and throwing here would 500 the webhook on the one
    // path that must never drop a message: somebody asking us to stop.
    //
    // So the narrower row goes in instead. The number is suppressed either
    // way; only the audit label is coarser until the SQL is pasted.
    if (error?.code === "23514") {
      const { error: retry } = await sb.from("sms_opt_outs").insert({ ...row, source: "inbound_keyword" });
      if (retry && retry.code !== "23505") throw asError("recording the opt-out", retry);
    } else if (error && error.code !== "23505") {
      throw asError("recording the opt-out", error);
    }
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
    .select("id, name, phone_e164, autosend_enabled, after_hours_autoreply, after_hours_message, time_zone, quiet_hours_start, quiet_hours_end, reply_delay_min_seconds, reply_delay_max_seconds")
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
        // Same rule as enrolment: somebody texting an AM number already has a
        // quote, and is not a new lead.
        track: trackForWorkspace(ws.name as string | null),
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
      // A26: that a photo arrived is the whole fact the rule needs, and it
      // was being discarded here. The count was computed on the way in, used
      // to decide the message was not empty, and then dropped, so the
      // acknowledgement in render.ts could never fire for a real customer.
      media_count: decision.mediaCount ?? 0,
    });
    // 23505 is the redelivery we expected.
    if (error && error.code !== "23505") throw asError("writing the inbound message", error);
    isNew = error?.code !== "23505";
    const receivedAt = new Date();

    // A44: DID THEY JUST TELL US WHEN NOT TO TEXT THEM?
    //
    // "once stated, it binds the whole cadence" and it does not expire, so it
    // is recorded the moment it is said rather than looked for later. Only on
    // a genuinely new message: a redelivery restating a constraint we already
    // hold would rewrite stated_at and make the provenance a lie.
    //
    // The LATEST statement wins. "Does not need to be repeated" means silence
    // never clears it; it does not mean somebody who changes shifts is stuck
    // with the window they gave in March.
    //
    // Best effort on purpose. This is a scheduling refinement, and failing to
    // record it must never cost us the inbound message itself.
    if (isNew) {
      const win = statedConstraint(decision.body);
      if (win) {
        const { data: msg } = await sb.from("sms_messages")
          .select("id").eq("conversation_id", conversationId)
          .eq("direction", "inbound").order("created_at", { ascending: false }).limit(1);
        const { error: rErr } = await sb.from("sms_conversations").update({
          unreachable_start_hour: win.startHour,
          unreachable_end_hour: win.endHour,
          unreachable_stated_at: receivedAt.toISOString(),
          unreachable_message_id: msg?.[0]?.id ?? null,
          updated_at: receivedAt.toISOString(),
        }).eq("id", conversationId);
        // 42703 is the migration not being applied yet. The conversation
        // carries on either way; the follow-ups simply are not shifted.
        if (rErr && rErr.code !== "42703") {
          reportWarn({
            key: "sms_reachability_not_recorded",
            message: "The customer said when they cannot be reached and it was not recorded",
            platform: "ppp_cc",
            context: { conversationId, error: rErr.message },
          });
        }
      }
    }

    // HELP IS ANSWERED, and it never reaches the model.
    //
    // compliance.ts has said "a reply is legally required" since the keywords
    // were written, and the only consumer of that classification was the line
    // below, which used it to keep the agent away — so HELP was recognised and
    // then answered by nobody. The reasoning was that the carrier replies
    // itself; that is true of a Twilio Messaging Service's Advanced Opt-Out,
    // and the adapter deliberately does not use one, so nothing in the path
    // ever did.
    //
    // A fixed body rather than a generated one: what a HELP reply must contain
    // is a rule, not a judgement, and a model that improvises it could drop
    // half the obligations on a bad day. It goes out as a send_reply so it
    // passes through the same gate as everything else — the suppression check,
    // the cap and the hours all still apply.
    if (isNew && decision.keyword === "help" && ws?.id) {
      const { data: inbound } = await sb.from("sms_messages")
        .select("id").eq("provider_id", decision.providerId).maybeSingle();
      // Needs the message it answers: sms_scheduled_actions_send_reply_chk
      // requires body, moment and answers_message_id together.
      if (inbound?.id) {
        const { error: hErr } = await sb.from("sms_scheduled_actions").insert({
          conversation_id: conversationId,
          action: "send_reply",
          // Now, not in thirty seconds. Somebody asking for help is waiting,
          // and the human-pacing delay exists to make marketing feel less
          // robotic — it has no business slowing down a required reply.
          run_at: receivedAt.toISOString(),
          reply_due_at: receivedAt.toISOString(),
          reply_body: helpReply(ws.phone_e164 ?? null),
          reply_intent: "help_response",
          answers_message_id: inbound.id,
        });
        if (hErr) {
          reportWarn({
            key: "sms_help_reply_not_queued",
            message: "Somebody texted HELP and the required reply could not be queued",
            platform: "ppp_cc",
            context: { conversationId, error: hErr.message },
          });
        }
      }
    }

    // OUT OF HOURS. The toggle on the Settings screen has been saved and read
    // by nothing since workspace hours were built, so a customer texting at
    // 10pm got silence while two other screens advertised the feature.
    //
    // Inside the federal 8am-9pm window only, and once per person per day —
    // see after-hours.ts for why that is the line.
    if (isNew && ws?.id && ws.after_hours_autoreply) {
      const dayAgo = new Date(receivedAt.getTime() - 24 * 3600_000).toISOString();
      const { count } = await sb.from("sms_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("agent_intent", AFTER_HOURS_INTENT)
        .gte("created_at", dayAgo);

      const autoReply = afterHoursReply({
        workspace: ws,
        now: receivedAt,
        alreadySentToday: count ?? 0,
        keyword: decision.keyword,
      });

      if (autoReply.send) {
        const { data: inbound } = await sb.from("sms_messages")
          .select("id").eq("provider_id", decision.providerId).maybeSingle();
        if (inbound?.id) {
          const { error: aErr } = await sb.from("sms_scheduled_actions").insert({
            conversation_id: conversationId,
            action: "send_reply",
            run_at: receivedAt.toISOString(),
            reply_due_at: receivedAt.toISOString(),
            reply_body: autoReply.body,
            reply_intent: AFTER_HOURS_INTENT,
            answers_message_id: inbound.id,
          });
          if (aErr) {
            reportWarn({
              key: "sms_after_hours_not_queued",
              message: "Could not queue the after-hours reply",
              platform: "ppp_cc",
              context: { conversationId, error: aErr.message },
            });
          }
        }
      }
    }

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
            // Whose evening cut-off the delay must not carry the reply past.
            // The customer's, because that is the one the gate will enforce.
            customerZone: customerZone({ phone: decision.from }).timeZone,
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
