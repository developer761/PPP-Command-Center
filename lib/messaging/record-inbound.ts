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
import { statedChannelPreference } from "./channel-preference";
import { removeFromCadenceFor, pauseCallingFor, setParkReminder } from "./stalled-db";
import { parkKind } from "./parking";
import { helpReply } from "./help-reply";
import { afterHoursReply, AFTER_HOURS_INTENT } from "./after-hours";
import { trackForWorkspace } from "./track";
// The SAME detector A25 uses, not a second one. Two patterns for "they asked
// to be phoned" is how one of them gets Spanish and the other does not — this
// one already has it.
import { ASKED_FOR_A_CALL } from "./customer-asks";
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
  /**
   * "DON'T TEXT ME, JUST CALL ME" IS A CHANNEL, NOT A GOODBYE.
   *
   * Kate, 2026-10-05: "Yes if they ask for us to stop texting and to call,
   * it's okay to route to a person. I don't think this is considered an
   * explicit opt-out, just a communication preference."
   *
   * Found in the simulator 2026-09-27, where every step behaved as written and
   * the outcome was still wrong: A24 reads "don't text me" as a revocation and
   * suppresses the number — correctly — and then the thread ended as `discard`,
   * so nothing recorded that this customer had asked to be CALLED. A person
   * reviewing saw "opted out" and moved on. Somebody who asked us to phone them
   * was filed as somebody who asked us to go away.
   *
   * HALF HER ANSWER IS TAKEN AND HALF IS NOT, deliberately. The routing is hers
   * to decide and is done. Whether the number stays suppressed is NOT —
   * legally "don't text me" is still a revocation of consent for texts, and
   * that is Katie's call with Karan. Suppressing somebody who need not have
   * been costs one text; failing to suppress somebody who should have been
   * costs $500-$1,500 a message. So the suppression below is untouched and
   * only the ENDING changes.
   *
   * Decided once, here, because it is read in two places — the conversation
   * this message opens and the conversation it joins. Two copies of this
   * expression is how the new-number path and the existing-thread path end up
   * disagreeing about the same customer.
   */
  const wantsACallInstead =
    decision.keyword === "opt_out" && ASKED_FOR_A_CALL.test(decision.body ?? "");

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
        // A call request lands in front of a person instead of ending — see
        // wantsACallInstead at the top. The number is still suppressed.
        state: wantsACallInstead ? "human_active"
          : decision.keyword === "opt_out" ? "ended" : "ai_active",
        outcome: decision.keyword === "opt_out" && !wantsACallInstead ? "discard" : null,
        ...(wantsACallInstead
          ? { takeover_reason: "customer_asked_human", takeover_at: new Date().toISOString() }
          : {}),
        // ended_at, NOT just outcome. sms_conversations_ended_shape demands
        // all three together, and this insert set only two — so a STOP from
        // somebody with no open conversation (a second STOP, or a number that
        // opted out long ago) violated the constraint and the webhook answered
        // 500. SNS then retried that same message for hours, failing every
        // time. Found the moment verify-inbound-e2e started running this code
        // instead of its own copy, which had quietly skipped the whole path.
        // All three of state/outcome/ended_at move together or
        // sms_conversations_ended_shape rejects the insert, which is why the
        // call-request branch clears this one too rather than only the state.
        ended_at: decision.keyword === "opt_out" && !wantsACallInstead
          ? new Date().toISOString() : null,
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
    // ── IS THAT STILL TRUE? UNVERIFIED, AND LEFT IN ANYWAY. 2026-10-02 ──
    //
    // Advanced Opt-Out was switched ON for the Messaging Service that day,
    // carrying our own HELP wording. The 646 is a sender in that service, so
    // Twilio MAY now answer HELP itself and a customer would get two replies.
    //
    // Not removed on that maybe. We send with `From`, never
    // MessagingServiceSid — transports/twilio.ts explains why — and whether
    // the service's opt-out management fires for inbound to a number that
    // merely belongs to it is not something to assume. The two mistakes are
    // not the same size: two HELP replies is embarrassing, zero is a CTIA
    // violation and carriers test for it.
    //
    // THE TEST, the moment the number can receive: text HELP and count the
    // replies. One, from us — leave this alone. Two — delete this block and
    // let Twilio own the keyword, since its handler answers even when the app
    // is down. Until somebody has actually sent that text, this stays.
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

      /**
       * Only a zone we actually RESOLVED, never the fallback.
       *
       * customerZone() always returns a timeZone — it falls back to Los
       * Angeles when neither the zip nor the area code says anything. That is
       * right for the gate, where a fallback errs toward a later send. It is
       * wrong here, because this hour goes into a SENTENCE: an Eastern
       * customer told "9 AM" resolved on a Pacific guess has been given a time
       * three hours out, stated as fact, with nothing marking it as a guess.
       * Passing "" makes next-open.ts label the hour ET instead, which the
       * reader can convert.
       */
      const zone = customerZone({ phone: decision.from });
      const autoReply = afterHoursReply({
        workspace: ws,
        now: receivedAt,
        alreadySentToday: count ?? 0,
        keyword: decision.keyword,
        customerZone: zone.source === "fallback" ? "" : zone.timeZone,
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

    /**
     * The same decision as the insert above — see wantsACallInstead at the top
     * of the function. The call signal stays skipped either way (A45 below):
     * handing the call centre an "in conversation" flag is a different thing
     * from putting the thread in front of a person, and only the second is
     * wanted here.
     */
    await sb.from("sms_conversations").update({
      last_message_at: new Date().toISOString(),
      ...(wantsACallInstead
        ? {
            state: "human_active",
            takeover_reason: "customer_asked_human",
            takeover_at: new Date().toISOString(),
          }
        : decision.keyword === "opt_out"
          ? { state: "ended", outcome: "discard", ended_at: new Date().toISOString() }
          : {}),
    }).eq("id", conversationId);

    /**
     * A45 — THE CUSTOMER REPLIED, SO STOP DIALLING THEM.
     *
     * "While a customer is actively in conversation with the Hub, the phone
     * team is not dialling them — nobody is worked on two channels at once."
     *
     * One per conversation, not one per reply: the unique index answers that,
     * so four messages arriving at once still produce one signal. A duplicate
     * comes back false rather than throwing, because a duplicate is the
     * constraint working.
     *
     * Never on an opt-out. Somebody who said STOP is suppressed, and handing
     * the call centre a "they are in conversation" signal about them would be
     * exactly wrong.
     */
    if (decision.keyword !== "opt_out") {
      try {
        const { data: c } = await sb.from("sms_conversations")
          .select("sf_lead_id, unreachable_start_hour, unreachable_end_hour")
          .eq("id", conversationId).limit(1);
        await pauseCallingFor(sb, {
          conversationId,
          leadId: c?.[0]?.sf_lead_id ?? null,
        });

        /**
         * A25 — THEY NAMED A CHANNEL AND WANT OFF THE PHONE.
         *
         * `statedChannelPreference` existed, was tested, and had ZERO
         * production callers — so a customer saying "stop calling me, just
         * text" produced no notification and stayed in the call cadence
         * indefinitely. The detector was built and never wired, which is the
         * shape this codebase keeps producing.
         *
         * Detected here rather than in the agent turn because it is something
         * the customer SAID, same as a park: the notification is owed whether
         * or not the bot is the one who answers next, and a turn that
         * escalates or is held by a human would otherwise swallow it.
         *
         * The phone branch is NOT this — that runs through the renderer,
         * because the bot cannot make a call and has to settle a callback
         * time before handing off.
         */
        const preference = statedChannelPreference(decision.body);
        if (preference === "text_only" || preference === "email_only") {
          try {
            await removeFromCadenceFor(sb, {
              conversationId,
              leadId: c?.[0]?.sf_lead_id ?? null,
              preference,
            });
          } catch (e) {
            reportWarn({
              key: "sms_cadence_removal_not_recorded",
              message: "Could not record the A25 remove-from-cadence notification",
              platform: "ppp_cc",
              context: { conversationId, error: e instanceof Error ? e.message : String(e) },
            });
          }
        }

        /**
         * A44 — THEY ANSWERED, SO STOP CHASING THEM.
         *
         * The cadence exists for a customer who has gone quiet. Once they
         * reply they are not quiet, and the remaining follow-ups are exactly
         * what A44's own guidance calls out: "a follow-up sent after the
         * customer has answered is not a follow-up, it is a redundant ask."
         *
         * Nothing cancelled these. `latestInboundIsAnswered` is deliberately
         * bypassed for `stall_followup` (scheduler-db) because a follow-up
         * speaks after ourselves by definition — correct for the quiet case,
         * and it also meant a customer who answered follow-up 1 still
         * received 2 and 3, a day and two days later.
         *
         * Only PENDING rows: one already claimed is mid-flight, and a
         * cancelled row is left alone so the unique index still sees the
         * cadence as spent rather than re-queueing it.
         */
        const { error: cancelErr } = await sb.from("sms_scheduled_actions")
          .update({
            state: "cancelled",
            cancelled_reason: "the customer replied, so the follow-up cadence stops",
            updated_at: new Date().toISOString(),
          })
          .eq("conversation_id", conversationId)
          .in("action", ["stall_followup", "park_reopen"])
          .eq("state", "pending");
        if (cancelErr) {
          // Loud: an uncancelled cadence keeps texting somebody who answered.
          reportWarn({
            key: "sms_cadence_not_cancelled",
            message: "Could not stop the follow-up cadence after a reply",
            platform: "ppp_cc",
            context: { conversationId, error: cancelErr.message },
          });
        }

        /**
         * A40 — IF THEY PARKED AND NAMED A TIME, SET THE REMINDER.
         *
         * Done here because a park is something the customer SAID; there is
         * no later moment at which it becomes true. Only a CONVERSATION park
         * counts — a field park ("not sure on dates") means carry on now, not
         * come back later, and parkKind is what tells the two apart.
         *
         * No time named is the ordinary case and not a failure: the spec
         * leaves that default to PPP — "do not pick one" — so the park simply
         * has no reminder and a person picks it up, exactly as today.
         */
        if (parkKind(decision.body) === "conversation") {
          const row = c?.[0] as { unreachable_start_hour?: number | null; unreachable_end_hour?: number | null } | undefined;
          await setParkReminder(sb, {
            conversationId,
            customerText: decision.body,
            customerPhone: decision.from,
            unreachable: typeof row?.unreachable_start_hour === "number"
              ? { startHour: row.unreachable_start_hour, endHour: row.unreachable_end_hour ?? row.unreachable_start_hour }
              : null,
          });
        }
      } catch (e) {
        // A signal that cannot be recorded must never break recording the
        // customer's message. The call centre keeps dialling, which is the
        // status quo rather than a new failure.
        reportWarn({
          key: "call_signal_pause_failed", platform: "ppp_cc",
          message: "could not record the pause-calling signal or the park reminder",
          context: { conversationId, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }

  return { conversationId, unknownNumber: !ws?.id, isNew };
}
