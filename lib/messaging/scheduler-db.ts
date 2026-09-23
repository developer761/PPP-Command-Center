/**
 * Supabase-backed ports for the scheduler worker.
 *
 * The worker itself is pure and injected; this is the only place that touches
 * the database, so every branch stays testable without one.
 */
import { messagingDb } from "./db";
import { gateDeps } from "./gate-deps";
import { toE164 } from "./phone";
import { fillMergeFields } from "./merge-fields";
import { agentConfigFor } from "./agent-config-for";
import { loadRetrievalCorpus, loadWorkspaceServices } from "./db";
import { runAgentTurn, agentFailureIsTransient } from "./agent-run";
import { stageFromIntents } from "./agent-output";
import { bumpStage, priorIntentsFor } from "./stage";
import { recordOutbound } from "./outbound";
import { resolveServices } from "./services";
import { selectExamples } from "./retrieval";
import { forPrompt } from "./class-a-rules";
import { loadClassARules } from "./class-a-rules-db";
import { takeoverReasonFor, latestInboundIsAnswered } from "./handoff";
import { trackForWorkspace, asTrack } from "./track";
import { gatedSend, type GateResult, type SendRequest } from "./gate";
import { emailAddressesFor } from "./reply-to";
import type { E164 } from "./phone";
import type { DueAction, SchedulerDeps } from "./scheduler";

/**
 * Ports for the worker. Deliberately does NOT import the transport: the gate
 * resolves its own, so nothing outside it ever holds an object that could send.
 */
export function schedulerDeps(): SchedulerDeps {
  const sb = messagingDb();

  return {
    async claimDue(limit) {
      const { data, error } = await sb.rpc("sms_claim_due_actions", { p_limit: limit });
      if (error) throw new Error(`claim failed: ${error.message}`);
      return (data ?? []) as DueAction[];
    },

    async resolve(a) {
      const { data } = await sb
        .from("sms_conversations")
        .select("state, customer_phone, customer_name, customer_email, sms_sub_accounts(id, name, phone_e164, origination_identity, reply_to_email, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
        .eq("id", a.conversation_id)
        .maybeSingle();
      if (!data) return null;
      const ws = data.sms_sub_accounts as unknown as {
        id: string; name: string; phone_e164: string | null; origination_identity: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
        reply_to_email: string | null;
      } | null;
      if (!ws) return null;

      let body = "";
      let subject: string | null = null;
      let channel: "sms" | "email" = "sms";
      const agent = "campaign";
      if (a.campaign_step_id) {
        const { data: step } = await sb
          .from("sms_campaign_steps").select("body, channel, subject").eq("id", a.campaign_step_id).maybeSingle();
        body = step?.body ?? "";
        subject = step?.subject ?? null;
        // An email step sent as an SMS would blast a subject line and newlines
        // at a phone number.
        channel = (step?.channel as "sms" | "email") ?? "sms";
      }

      // Fill the blanks BEFORE the gate sees it. The gate refuses anything
      // still carrying a placeholder, which is the backstop rather than the
      // mechanism.
      //
      // office_location is offered by the editor and was never passed here, so
      // a message using it was refused at every attempt until it failed. It is
      // the same office the bot states, resolved the same way (global, then
      // state, then workspace), and only looked up when the message wants it.
      const wantsOffice = body.includes("{{office_location}}");
      const cfg = wantsOffice ? await agentConfigFor(ws.id) : null;
      body = fillMergeFields(body, {
        workspacePhone: ws.phone_e164,
        workspaceName: ws.name,
        customerName: data.customer_name,
        officeLocation: cfg?.cfg.office_location ?? null,
        // A lead with no first name is common (a form with a phone and
        // nothing else). "Hi {{customer_name}}" would otherwise be refused
        // and the whole sequence would silently never send to them.
        customerNameFallback: "there",
      });
      // Always FROM the shared, verified sender; the workspace's own inbox is
      // the Reply-To. The workspace address used to go in From, which Resend
      // refuses for any domain it has not verified. See reply-to.ts.
      const addresses = emailAddressesFor({
        workspaceReplyTo: ws.reply_to_email,
        sharedFrom: process.env.RESEND_FROM_ADDRESS,
      });
      return {
        workspace: ws,
        to: data.customer_phone as E164,
        body, agent,
        conversationState: data.state as string,
        channel,
        toEmail: data.customer_email as string | null,
        fromEmail: addresses.from,
        replyToEmail: addresses.replyTo,
        subject,
      };
    },

    async send(req: SendRequest): Promise<GateResult> {
      // Deps live in gate-deps.ts because the draft-review screen sends too,
      // and two copies of the suppression lookup is how the email half quietly
      // stops being checked on one path.
      return gatedSend(req, gateDeps(sb));
    },

    /**
     * Run the agent against a real conversation and park the reply.
     *
     * THE FIRST TIME THE AGENT TOUCHES A REAL CUSTOMER THREAD. Everything
     * before this ran it in the sandbox only. It resolves the same config, the
     * same per-workspace services and the same corpus a simulator turn does,
     * because a bot that behaves differently in testing than in production is
     * a bot nobody has actually tested.
     */
    async draftReply(a: DueAction) {
      const { data: conv } = await sb
        .from("sms_conversations")
        .select("id, state, track, customer_phone, customer_name, customer_email, workspace_id, sms_sub_accounts(id, name, autosend_enabled, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
        .eq("id", a.conversation_id).maybeSingle();
      if (!conv) return { kind: "skipped" as const, reason: "conversation no longer exists" };
      if (conv.state === "ended") return { kind: "skipped" as const, reason: "conversation has ended" };
      // A person has this one. The bot drafting alongside them is two voices
      // answering one customer, which is the failure handing over exists to
      // prevent — so it stops here rather than filing a draft nobody asked for.
      // This guard and the claim button have to ship together: without it,
      // taking a conversation over does not actually take it off the bot.
      if (conv.state === "human_active") {
        return { kind: "skipped" as const, reason: "a person has taken this conversation over" };
      }

      const ws = conv.sms_sub_accounts as unknown as {
        id: string; name: string; autosend_enabled: boolean; origination_identity: string | null;
        phone_e164: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
      } | null;
      if (!ws) return { kind: "skipped" as const, reason: "conversation has no workspace" };
      const wsFull = ws;

      // One pending draft per conversation is a database rule; checking here
      // turns a constraint violation into a clean skip.
      const { data: existing } = await sb.from("sms_drafts")
        .select("id").eq("conversation_id", conv.id).eq("state", "pending").maybeSingle();
      if (existing) return { kind: "skipped" as const, reason: "a reply is already waiting for review" };

      const { data: msgs } = await sb.from("sms_messages")
        .select("id, direction, body, created_at, media_count")
        .eq("conversation_id", conv.id).order("created_at");
      const history = (msgs ?? []).map((m) => ({
        role: (m.direction === "inbound" ? "customer" : "assistant") as "customer" | "assistant",
        text: m.body,
      }));
      const lastInbound = [...(msgs ?? [])].reverse().find((m) => m.direction === "inbound");
      if (!lastInbound) return { kind: "skipped" as const, reason: "nothing to reply to" };

      // SOMEBODY ALREADY ANSWERED. Usually a person who took the conversation
      // over, replied, and handed it back — which leaves this turn pending,
      // because releasing to 'awaiting_customer' neither re-queues nor cancels.
      // Without this the bot answers a message a person answered an hour ago,
      // and the slice below strips their reply out of the transcript first.
      if (latestInboundIsAnswered(msgs ?? [])) {
        return { kind: "skipped" as const, reason: "somebody has already answered the customer" };
      }

      // A reply already held for this conversation. If it answers the latest
      // message, this turn has nothing to add: it is the second turn queued by
      // a burst of texts. If it answers an older one, the customer has said
      // more since, so it is dropped and this turn answers everything.
      const { data: held } = await sb.from("sms_scheduled_actions")
        .select("id, answers_message_id")
        .eq("conversation_id", conv.id).eq("action", "send_reply").in("state", ["pending", "claimed"]);
      if ((held ?? []).some((h) => h.answers_message_id === lastInbound.id)) {
        return { kind: "skipped" as const, reason: "a reply to the latest message is already on its way" };
      }
      const stale = (held ?? []).map((h) => h.id);
      if (stale.length) {
        await sb.from("sms_scheduled_actions").update({
          state: "cancelled", cancelled_reason: "the customer texted again before it was due",
          updated_at: new Date().toISOString(),
        }).in("id", stale).eq("state", "pending");
      }

      // Everything the sandbox resolves, resolved the same way.
      // THE TRACK. A conversation in an AM workspace has already had an
      // estimator at the house and holds a written quote; running the
      // new-lead prompt on it asks for their address. Stored on the row, and
      // falling back to the workspace name for conversations created before
      // anything wrote it.
      const track = conv.track ? asTrack(conv.track as string) : trackForWorkspace(ws.name);

      const [cfg, corpus, svc] = await Promise.all([
        agentConfigFor(conv.workspace_id, track),
        loadRetrievalCorpus(),
        loadWorkspaceServices(conv.workspace_id),
      ]);
      if (!cfg) return { kind: "skipped" as const, reason: "no agent configuration" };

      // THE LEASH. max_turns has been saved, resolved and displayed on the
      // Agent page under "Longer than this hands to a human rather than
      // looping" — and enforced by nothing, so there was no cap on how long a
      // conversation could run, nor on what it could cost.
      //
      // Checked BEFORE the model is called, not after: a conversation that has
      // already gone too far should not spend another request to find that
      // out. Counted in replies we actually sent, because that is what the
      // customer experienced.
      if (cfg.maxTurns != null && cfg.maxTurns > 0) {
        const sentSoFar = (msgs ?? []).filter((m) => m.direction === "outbound").length;
        if (sentSoFar >= cfg.maxTurns) {
          // Handed over with no message. Karan, 2026-09-22: a customer the bot
          // has already failed to help does not need one more text from it.
          // human_active with no owner IS the "Needs a person" queue.
          await sb.from("sms_conversations").update({
            state: "human_active",
            takeover_reason: "repeated_confusion",
            takeover_at: new Date().toISOString(),
          }).eq("id", conv.id).neq("state", "ended").is("owning_user_id", null);
          return {
            kind: "skipped" as const,
            reason: `handed to a person after ${sentSoFar} replies (max_turns is ${cfg.maxTurns})`,
          };
        }
      }

      // SENT MESSAGES AS WELL AS DRAFTS. This read sms_drafts alone, which is
      // complete only while a person reviews every reply — the autosend and
      // held-reply paths send without writing one. On an autosending workspace
      // the list was therefore always empty, the agent believed it was
      // permanently at stage 0, and its own validator refused ask_address,
      // ask_contact and ask_availability as out of order for the rest of the
      // conversation. Invisible in testing, because testing has autosend off.
      const priorIntents = await priorIntentsFor(sb, conv.id);
      const stage = stageFromIntents(priorIntents);

      // Kate 44 Class A rules, the standard this reply will be graded
      // against. Rendered by forPrompt, which never sees her rater-only
      // column because it is not in the table this loader reads.
      const classARules = forPrompt(await loadClassARules());

      const res = await runAgentTurn(cfg.cfg, history.slice(0, -1), lastInbound.body, {
        hardNos: cfg.hardNos,
        classARules,
        track,
        stage,
        lastIntent: priorIntents[priorIntents.length - 1] ?? undefined,
        known: {
          name: conv.customer_name, phone: conv.customer_phone, email: conv.customer_email,
        },
        services: resolveServices(svc.services, svc.exceptions),
        examples: selectExamples(corpus, { stage }),
        // A26: acknowledge the photo they just sent. Read from the message
        // rather than the webhook because the turn runs seconds later, in a
        // different process, from the row.
        mediaCount: (lastInbound as { media_count?: number }).media_count ?? 0,
      });

      if (!res.ok) {
        // TWO VERY DIFFERENT FAILURES, and treating them alike lost replies.
        //
        // `rejected` is our own output validator refusing what the model
        // chose. That is semantic: it will be refused again next minute, so
        // retrying is pointless and the turn is closed.
        //
        // Everything else — a 429, a 529 overloaded, a socket reset, a
        // missing ANTHROPIC_API_KEY — is infrastructure. runAgentTurn catches
        // those and returns ok:false rather than throwing, so they arrived
        // here looking identical to a rejection and runAction CANCELLED the
        // action: the customer was never answered, there was no draft, no
        // "needs human", and no alert, because a cancel is not a failure.
        // A rate-limited minute silently dropped every reply in it.
        //
        // Throwing puts it on runAction's retry path instead, where it gets
        // backoff and, if it really is broken, an honest `failed`.
        if (!agentFailureIsTransient(res)) return { kind: "skipped" as const, reason: res.rejected! };
        throw new Error(`the agent could not produce a reply: ${res.error}`);
      }
      if (!res.rendered.trim()) return { kind: "skipped" as const, reason: "the agent had nothing to say" };

      // AUTOSEND, and what it does and does not mean.
      //
      // A workspace that has earned it replies without a person — but only
      // through the gate, and never when the agent asked for one. Escalation
      // wins over autosend every time: "I am not sure" is exactly the case a
      // human is for, and a workspace being trusted in general says nothing
      // about this particular turn.
      //
      // Until this flag was wired it changed only the LABEL on a draft, so
      // turning it on would have produced a queue that still needed working
      // and said it did not. A switch that does not do what it says is worse
      // than no switch.
      const to = toE164(conv.customer_phone);
      if (ws.autosend_enabled && !res.escalate && to) {
        // HELD UNTIL ITS MOMENT. The webhook drew reply_due_at from the
        // workspace's range, counted from the customer's text. If that moment
        // is still ahead, the reply waits as a send_reply row rather than
        // going now. Sending early would put a machine-speed answer back.
        const dueAt = a.reply_due_at ? new Date(a.reply_due_at) : null;
        if (dueAt && dueAt.getTime() > Date.now() + 1000) {
          const { error: holdErr } = await sb.from("sms_scheduled_actions").insert({
            conversation_id: conv.id,
            action: "send_reply",
            run_at: dueAt.toISOString(),
            reply_due_at: dueAt.toISOString(),
            reply_body: res.rendered,
            reply_intent: res.action.intent,
            reply_confidence: res.action.confidence,
            answers_message_id: lastInbound.id,
          });
          if (holdErr) throw new Error(`could not hold the reply: ${holdErr.message}`);
          return { kind: "held" as const, at: dueAt };
        }

        const sent = await gatedSend(
          { workspace: wsFull, to, body: res.rendered, agent: "agent_autosend" },
          gateDeps(sb)
        );
        if (sent.ok) {
          return { kind: "sent" as const, providerId: sent.providerId, body: sent.body, intent: res.action.intent };
        }
        // Refused. It becomes a draft rather than vanishing, so a person sees
        // the reply the gate would not let out and decides what to do.
        await sb.from("sms_drafts").insert({
          conversation_id: conv.id, answers_message_id: lastInbound.id,
          intent: res.action.intent, confidence: res.action.confidence,
          body: res.rendered, review_reason: "autosend_off",
          send_error: sent.reason,
        });
        return { kind: "drafted" as const };
      }

      const reason = res.escalate ? "escalated" : "autosend_off";

      // An escalation that only files a draft leaves the conversation looking
      // like the bot is still working it, and the "Needs human" bucket empty.
      // Moving it to human_active with no owner IS that queue: needed by
      // somebody, claimed by nobody. The reason is the little the agent can
      // actually attribute — a person claiming it says what it really was.
      if (res.escalate) {
        await sb.from("sms_conversations").update({
          state: "human_active",
          takeover_reason: takeoverReasonFor({
            intent: res.action.intent,
            confidence: res.action.confidence,
            threshold: cfg.cfg.confidence_threshold,
          }),
          takeover_at: new Date().toISOString(),
        }).eq("id", conv.id).neq("state", "ended").is("owning_user_id", null);
      }

      const { error } = await sb.from("sms_drafts").insert({
        conversation_id: conv.id,
        answers_message_id: lastInbound.id,
        intent: res.action.intent,
        confidence: res.action.confidence,
        reasoning: res.droppedRapport ? `A sentence was removed: ${res.droppedRapport}` : null,
        body: res.rendered,
        review_reason: reason,
      });
      if (error) throw new Error(`could not write the draft: ${error.message}`);
      return { kind: "drafted" as const };
    },

    async sendHeldReply(a: DueAction) {
      const { data: conv } = await sb
        .from("sms_conversations")
        .select("id, customer_phone, sms_sub_accounts(id, name, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
        .eq("id", a.conversation_id).maybeSingle();
      if (!conv) return { kind: "skipped" as const, reason: "conversation no longer exists" };
      const ws = conv.sms_sub_accounts as unknown as {
        id: string; name: string; phone_e164: string | null; origination_identity: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
      } | null;
      if (!ws) return { kind: "skipped" as const, reason: "conversation has no workspace" };
      if (!a.reply_body || !a.answers_message_id) return { kind: "skipped" as const, reason: "held reply has no text" };

      // Stale? The customer has texted since this was written, so it answers
      // the wrong message. Their newer text queued its own turn.
      const { data: latest } = await sb.from("sms_messages")
        .select("id").eq("conversation_id", conv.id).eq("direction", "inbound")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (latest && latest.id !== a.answers_message_id) {
        return { kind: "skipped" as const, reason: "the customer texted again before it was due" };
      }

      const to = toE164(conv.customer_phone);
      if (!to) return { kind: "skipped" as const, reason: "no textable number" };
      // ANSWERS AN INBOUND, so the workspace's own sending hours give way to
      // the federal 8am-9pm bound. Every held reply is by definition a reply
      // to a message the customer sent — that is what answers_message_id
      // means — and this is what lets the HELP reply and the after-hours reply
      // reach somebody who texted at half past eight. Nothing else relaxes:
      // suppression, the empty-list rail, the daily cap and the federal window
      // all still apply, and 2am is still refused.
      const sent = await gatedSend(
        { workspace: ws, to, body: a.reply_body, agent: "agent_autosend", answersInbound: true },
        gateDeps(sb)
      );
      if (sent.ok) return { kind: "sent" as const, providerId: sent.providerId, body: sent.body };

      // Refused at its moment (quiet hours began, the cap was reached). It
      // becomes a draft for a person, the same as an autosend refusal always has.
      await sb.from("sms_drafts").insert({
        conversation_id: conv.id, answers_message_id: a.answers_message_id,
        intent: a.reply_intent, confidence: a.reply_confidence,
        body: a.reply_body, review_reason: "autosend_off", send_error: sent.reason,
      });
      return { kind: "drafted" as const };
    },

    async markDone(a) {
      await sb.from("sms_scheduled_actions").update({ state: "done", updated_at: new Date().toISOString() }).eq("id", a.id);
    },

    async markSent(a, providerId, body, channel = "sms", intent) {
      // THE INTENT, on the message. A held reply carries it on the action
      // row; an immediate autosend passes it in. A campaign step has none,
      // and a person's own words have none — both correctly null.
      const agentIntent = intent ?? a.reply_intent ?? null;
      await recordOutbound(sb, {
        conversation_id: a.conversation_id, body, provider_id: providerId,
        channel, agent_intent: agentIntent,
      });
      await sb.from("sms_scheduled_actions").update({ state: "done", updated_at: new Date().toISOString() }).eq("id", a.id);
      await sb.from("sms_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", a.conversation_id);
      await bumpStage(sb, a.conversation_id, agentIntent);
    },

    async reschedule(a, at, reason, why) {
      await sb.from("sms_scheduled_actions").update({
        state: "pending", claimed_at: null, run_at: at.toISOString(),
        last_error: reason, updated_at: new Date().toISOString(),
        // GIVE THE ATTEMPT BACK when nothing actually went wrong.
        //
        // sms_claim_due_actions increments attempts on CLAIM, so a row that
        // was merely deferred — quiet hours, the daily cap, an opt-out list
        // nobody has imported yet, a person holding the conversation — spent
        // one of its five lives for doing nothing. Five deferrals and the
        // message was failed permanently, which is how "held so the queue
        // drains by itself" became "the queue kills itself by morning".
        // An "error" still spends one, so a genuinely broken row stays bounded.
        ...(why === "deferral" ? { attempts: Math.max(0, a.attempts - 1) } : {}),
      }).eq("id", a.id);
    },

    async cancel(a, reason) {
      await sb.from("sms_scheduled_actions").update({
        state: "cancelled", cancelled_reason: reason, updated_at: new Date().toISOString(),
      }).eq("id", a.id);
    },

    async fail(a, reason) {
      await sb.from("sms_scheduled_actions").update({
        state: "failed", last_error: reason, updated_at: new Date().toISOString(),
      }).eq("id", a.id);
    },
  };
}

export async function reclaimStale(): Promise<number> {
  const sb = messagingDb();
  const { data, error } = await sb.rpc("sms_reclaim_stale_actions");
  if (error) return 0;
  return (data as number) ?? 0;
}
