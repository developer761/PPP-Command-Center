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
import { officeIsOpen, recipientDayIsOver } from "./sending-window";
import { loadWorkspaceFaqs } from "./workspace-faq-db";
import { faqsForPrompt } from "./workspace-faq";
import { reportWarn } from "@/lib/observability";
import { resumeCallingIfSpent } from "./stalled-db";
import { customerZone } from "./customer-clock";
import { stageFromIntents } from "./agent-output";
import { bumpStage, priorIntentsFor } from "./stage";
import { knownFromThread } from "./known-from-thread";
import { serviceZipCheck } from "./service-zip";
import { recordOutbound } from "./outbound";
import { resolveServices } from "./services";
import { forPrompt } from "./class-a-rules";
import { loadClassARules } from "./class-a-rules-db";
import { takeoverReasonFor, latestInboundIsAnswered, type TakeoverReason } from "./handoff";
import { trackForWorkspace, asTrack } from "./track";
import { gatedSend, type GateResult, type SendRequest } from "./gate";
import { emailAddressesFor } from "./reply-to";
import type { E164 } from "./phone";
import type { DueAction, SchedulerDeps } from "./scheduler";

/**
 * Ports for the worker. Deliberately does NOT import the transport: the gate
 * resolves its own, so nothing outside it ever holds an object that could send.
 */

/**
 * The bot escalating itself: human_active with no owner IS the "Needs a
 * person" queue — needed by somebody, claimed by nobody.
 *
 * ONE WRITER, AND IT IS TYPED, because the four call sites that used to spell
 * this update out by hand were four chances to get it wrong and I took one of
 * them. `takeover_reason: "agent_uncertain"` reads perfectly well and is not
 * a value sms_conversations_takeover_chk allows, so Postgres refused the row
 * with 23514 — onto an update whose error nobody read, which then returned
 * "handed to a person" while the conversation stayed exactly where it was,
 * silent, with the customer still waiting. A TakeoverReason parameter makes
 * that a type error instead of a runtime lie.
 *
 * Guards, both deliberate: an ended conversation is not re-opened by an
 * escalation, and one a person already claimed is left alone rather than
 * having its reason overwritten by the bot.
 */
async function handToAPerson(
  sb: ReturnType<typeof messagingDb>,
  conversationId: string,
  reason: TakeoverReason,
): Promise<void> {
  const { error } = await sb.from("sms_conversations").update({
    state: "human_active",
    takeover_reason: reason,
    takeover_at: new Date().toISOString(),
  }).eq("id", conversationId).neq("state", "ended").is("owning_user_id", null);
  // Matching no row is fine and expected — ended, or already somebody's. An
  // ERROR is not: it means the handover did not happen, and the caller is
  // about to tell the log that it did.
  if (error) throw new Error(`could not hand the conversation to a person: ${error.message}`);
}

export function schedulerDeps(): SchedulerDeps {
  const sb = messagingDb();

  return {
    /**
     * A45 — the cadence is spent, so hand the lead back to the phone team.
     *
     * Reached only from the branch that SENT the third follow-up. A cadence
     * that was cancelled or refused never reached the customer, and claiming
     * three attempts that did not happen would put the lead back on the
     * phones having actually chased them once.
     *
     * Never throws into the scheduler: a signal that cannot be recorded must
     * not fail the message that just went out. The call centre carries on as
     * it was, which is the status quo rather than a new failure.
     */
    async onCadenceSpent(a) {
      try {
        const { data } = await sb.from("sms_conversations")
          .select("sf_lead_id").eq("id", a.conversation_id).limit(1);
        await resumeCallingIfSpent(sb, {
          conversationId: a.conversation_id,
          leadId: data?.[0]?.sf_lead_id ?? null,
        });
      } catch (err) {
        reportWarn({
          key: "call_signal_resume_failed", platform: "ppp_cc",
          message: "could not record the resume-calling signal",
          context: { conversationId: a.conversation_id, error: err instanceof Error ? err.message : String(err) },
        });
      }
    },

    /**
     * The carrier had them suppressed and we did not. Write our own row so the
     * gap closes: the next attempt from any workspace is stopped by our own
     * gate instead of by a failed send.
     *
     * source 'carrier' rather than a keyword or a phrase, because that is what
     * it is — Twilio told us, the customer did not. If an opt-out is ever
     * disputed, "their carrier had them on its list" is different evidence
     * from "they replied STOP", and the column exists to keep them apart.
     *
     * A duplicate key is the outcome we wanted anyway, so it is not an error.
     */
    async onCarrierSuppressed(_a, to) {
      const { error } = await sb.from("sms_opt_outs").insert({
        phone_e164: to,
        channel: "sms",
        inbound_body: null,
        source: "carrier",
        opted_out_at: new Date().toISOString(),
      });
      if (error && error.code !== "23505") {
        /**
         * A source CHECK that does not know 'carrier' must not lose the
         * suppression — the same reasoning record-inbound uses for
         * 'inbound_phrase'. The number matters; the label is the part that can
         * wait for the migration.
         */
        const { error: retry } = await sb.from("sms_opt_outs").insert({
          phone_e164: to, channel: "sms", inbound_body: null,
          source: "inbound_keyword", opted_out_at: new Date().toISOString(),
        });
        if (retry && retry.code !== "23505") {
          reportWarn({
            key: "carrier_optout_not_recorded", platform: "ppp_cc",
            message: "the carrier refused a send as unsubscribed and we could not record it",
            context: { to, error: retry.message, code: retry.code ?? null },
          });
        }
      }
    },

    async claimDue(limit) {
      const { data, error } = await sb.rpc("sms_claim_due_actions", { p_limit: limit });
      if (error) throw new Error(`claim failed: ${error.message}`);
      return (data ?? []) as DueAction[];
    },

    async resolve(a) {
      const { data } = await sb
        .from("sms_conversations")
        .select("state, takeover_at, customer_phone, customer_name, customer_email, sms_sub_accounts(id, name, phone_e164, origination_identity, reply_to_email, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, send_on_holidays)")
        .eq("id", a.conversation_id)
        .maybeSingle();
      if (!data) return null;
      const ws = data.sms_sub_accounts as unknown as {
        id: string; name: string; phone_e164: string | null; origination_identity: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean; send_on_holidays: boolean;
        reply_to_email: string | null;
      } | null;
      if (!ws) return null;

      let body = "";
      let subject: string | null = null;
      let channel: "sms" | "email" = "sms";
      const agent = "campaign";
      if (a.campaign_step_id) {
        // THE OUTREACH CAMPAIGN IS FOR BEFORE THEY REPLY.
        //
        // Kate, 2026-09-23: "There's a campaign before a customer replies,
        // then there's a campaign if they don't reply." This is the first
        // one. Once somebody has answered, the conversation takes over, and
        // what happens if they later go quiet is the stalled-conversation
        // cadence rather than the rest of this sequence.
        //
        // Nothing stopped it. The exit rules watch Salesforce only —
        // IsConverted, Status, SMS_Opt_In__c and two Opportunity fields — so
        // a customer mid-conversation with the bot still got "just following
        // up on your estimate request. Are you still looking to get this
        // done?" on day 1 and again on day 3. A44 states the principle
        // plainly for its own cadence: "A follow-up sent after the customer
        // has answered is not a follow-up, it is a redundant ask."
        const { count: replies } = await sb.from("sms_messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", a.conversation_id).eq("direction", "inbound");
        if ((replies ?? 0) > 0) {
          return { cancelBecause: "the customer replied, so the outreach sequence stops here" };
        }

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
        // WHEN the person took it, not just that they have it. A deferral
        // needs a horizon or it is a loop; see the human_active branch in
        // scheduler.ts.
        takeoverAt: (data as { takeover_at?: string | null }).takeover_at ?? null,
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
        .select("id, state, track, customer_phone, customer_name, customer_email, customer_address, customer_zip, inquiry_scope, workspace_id, sms_sub_accounts(id, name, autosend_enabled, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, send_on_holidays)")
        .eq("id", a.conversation_id).maybeSingle();
      if (!conv) return { kind: "skipped" as const, reason: "conversation no longer exists" };
      if (conv.state === "ended") return { kind: "skipped" as const, reason: "conversation has ended" };
      // A person has this one. The bot drafting alongside them is two voices
      // answering one customer, which is the failure handing over exists to
      // prevent — so it stops here rather than filing a draft nobody asked for.
      // This guard and the claim button have to ship together: without it,
      // taking a conversation over does not actually take it off the bot.
      if (conv.state === "human_active") {
        return { kind: "skipped" as const, reason: "a person has taken this conversation over", retryable: true };
      }

      const ws = conv.sms_sub_accounts as unknown as {
        id: string; name: string; autosend_enabled: boolean; origination_identity: string | null;
        phone_e164: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean; send_on_holidays: boolean;
      } | null;
      if (!ws) return { kind: "skipped" as const, reason: "conversation has no workspace" };
      const wsFull = ws;

      // One pending draft per conversation is a database rule; checking here
      // turns a constraint violation into a clean skip.
      const { data: existing } = await sb.from("sms_drafts")
        .select("id").eq("conversation_id", conv.id).eq("state", "pending").maybeSingle();
      if (existing) return { kind: "skipped" as const, reason: "a reply is already waiting for review", retryable: true };

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
      /**
       * A44's FOLLOW-UP IS THE ONE TURN THAT MAY SPEAK AFTER OURSELVES.
       *
       * This guard is right for an ordinary agent_turn: do not answer a
       * message somebody already answered. But a STALLED conversation is
       * defined by the last turn being ours — so the latest inbound is always
       * answered, and without this carve-out every stall follow-up skips with
       * "somebody has already answered the customer".
       *
       * Caught on 2026-09-26 before the first cadence fired. It would have
       * queued nine rows, run them all, skipped all nine, and reported a
       * healthy tick — the same silent-nothing as the constraint bug an hour
       * earlier, and just as invisible.
       */
      // A park re-open speaks after ourselves for the same reason a stall
      // follow-up does: the bot acknowledged the park, so the latest inbound
      // is always already answered.
      const isStallFollowUp = a.action === "stall_followup" || a.action === "park_reopen";
      if (!isStallFollowUp && latestInboundIsAnswered(msgs ?? [])) {
        return { kind: "skipped" as const, reason: "somebody has already answered the customer" };
      }

      // A reply already held for this conversation. If it answers the latest
      // message, this turn has nothing to add: it is the second turn queued by
      // a burst of texts. If it answers an older one, the customer has said
      // more since, so it is dropped and this turn answers everything.
      const { data: held } = await sb.from("sms_scheduled_actions")
        .select("id, answers_message_id")
        .eq("conversation_id", conv.id).eq("action", "send_reply").in("state", ["pending", "claimed"]);
      if (!isStallFollowUp && (held ?? []).some((h) => h.answers_message_id === lastInbound.id)) {
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
          await handToAPerson(sb, conv.id, "repeated_confusion");
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
      const stage0 = stageFromIntents(priorIntents);

      // WHAT THE CUSTOMER TOLD US IS ALSO COLLECTED.
      //
      // inquiry_scope is written once at enrolment and never again, so a lead
      // who opens by describing the job left the record empty and the flow
      // stuck: ask_project_details is the only legal move and the model will
      // not take it, having been told never to ask for what they have already
      // given. Five out of five in the simulator, on the opening a Web Inquiry
      // lead uses most.
      //
      // The step was done. Only the bookkeeping disagreed.
      // Scope and stage together, shared with the simulator so the sandbox
      // cannot answer differently from production. Reads the customer's own
      // words: a reaction arrives as `Liked "<our message>"` and would
      // otherwise record our sentence as their project.
      // ONE DERIVATION, SHARED WITH THE SIMULATOR. See known-from-thread.ts:
      // these two answered "what do we hold" separately and drifted apart
      // four times in a day, every time with the sandbox knowing less.
      //
      // The conversation row already remembers anything found on an earlier
      // turn, so the latest inbound is the only message this has to read.
      const resolved = knownFromThread({
        onFile: {
          inquiryScope: (conv as { inquiry_scope?: string | null }).inquiry_scope,
          address: (conv as { customer_address?: string | null }).customer_address,
          email: (conv as { customer_email?: string | null }).customer_email,
        },
        messages: [{
          body: lastInbound.body,
          mediaCount: (lastInbound as { media_count?: number }).media_count ?? 0,
        }],
        stage: stage0,
      });
      const stage = resolved.stage;

      // Persisted so the next turn does not have to find it again, and so the
      // thread and the reporting show what the conversation is actually about.
      // Guarded on the column still being empty: what PPP had on the lead is
      // the office's version and is never overwritten by ours.
      if (resolved.scopeFrom === "customer" && resolved.inquiryScope) {
        const { error: scopeErr } = await sb.from("sms_conversations")
          .update({ inquiry_scope: resolved.inquiryScope })
          .eq("id", conv.id)
          .is("inquiry_scope", null);
        // Not fatal. The turn can still run on the value we just derived.
        if (scopeErr) console.warn(`could not store the scope: ${scopeErr.message}`);
      }

      /**
       * THE ADDRESS THEY TYPED, WHICH NOTHING WAS KEEPING EITHER.
       *
       * customer_address is written once at enrolment and was never written
       * again, so an address given in the thread was held nowhere. The same
       * hole inquiry_scope had, and three things fell out of it on a single
       * simulator message: confirm_address could never render although A3
       * REQUIRES the address to be confirmed before the conversation ends,
       * the bot asked again for what it had just been given (A11, the most
       * breached critical rule in Kate's grading), and the model's attempt to
       * acknowledge it in rapport instead was refused for containing a
       * number, because every number a customer sees comes from a template.
       *
       * Only when the column is empty. What PPP holds on the lead is the
       * office's version and this never overwrites it.
       */
      if (resolved.addressFromChat && resolved.address) {
        const { error: addrErr } = await sb.from("sms_conversations")
          .update({ customer_address: resolved.address })
          .eq("id", conv.id)
          .is("customer_address", null);
        // Not fatal. The turn still runs on the value just derived.
        if (addrErr) console.warn(`could not store the address: ${addrErr.message}`);
      }

      /**
       * AND THE EMAIL, WHICH COST THE MOST TO LOSE.
       *
       * The bot asks for it by name and the answer was kept nowhere:
       * customer_email is written at enrolment and never again. On the
       * off-site route this column is what the quote is SENT to
       * (`toEmail: data.customer_email`), so the bot collected the one thing
       * the route needs and then dropped it.
       *
       * emailFromCustomer refuses anything ambiguous — two addresses in one
       * message, or one of ours — so this only ever writes a value nobody has
       * to adjudicate. Guarded on the column being empty for the same reason
       * as the two above: what PPP holds on the lead is the office's version.
       */
      if (resolved.emailFromChat && resolved.email) {
        const { error: emailErr } = await sb.from("sms_conversations")
          .update({ customer_email: resolved.email })
          .eq("id", conv.id)
          .is("customer_email", null);
        // Not fatal. The turn still runs on the value just derived.
        if (emailErr) console.warn(`could not store the email: ${emailErr.message}`);
      }

      // Kate 44 Class A rules, the standard this reply will be graded
      // against. Rendered by forPrompt, which never sees her rater-only
      // column because it is not in the table this loader reads.
      const classARules = forPrompt(await loadClassARules());
      // Parity gap 9: this workspace's standing answers. Empty string when it
      // has none, which is every workspace today — the section simply does
      // not appear rather than a heading over nothing.
      const workspaceFaqs = faqsForPrompt(await loadWorkspaceFaqs(sb, conv.workspace_id));

      // A2 MID-CONVERSATION. The zip on the lead goes stale — one of Kate's
      // findings is a customer giving a New Jersey address while FL 33308 sat
      // on the record — so the zip we hold NOW is re-checked every turn,
      // against our own table rather than Salesforce. An unreadable map
      // answers needs_a_person, never "not serviced", because telling a
      // customer we do not cover them on a failed lookup is the harm A2
      // exists to prevent.
      const service = (conv as { customer_zip?: string | null }).customer_zip
        ? await serviceZipCheck(sb, (conv as { customer_zip?: string | null }).customer_zip!)
        : null;

      const res = await runAgentTurn(cfg.cfg, history.slice(0, -1), lastInbound.body, {
        hardNos: cfg.hardNos,
        classARules,
        workspaceFaqs,
        track,
        stage,
        lastIntent: priorIntents[priorIntents.length - 1] ?? undefined,
        /**
         * WHETHER OUR LAST MESSAGE ASKED FOR SOMETHING — AND A REACTION
         * MEANS NOTHING WITHOUT IT.
         *
         * This was passed by the sandbox and NOT by production, so
         * agent-run defaulted it to false and every reaction in a real
         * conversation took the "informational" branch: "Nothing needs
         * saying: end as Msg Liked/Loved." A thumbs-up on "what's the
         * address?" ended the conversation.
         *
         * The spec names this failure and what it cost: Hatch delivered a
         * reaction as text, the bot answered its own question, "one
         * conversation ended that way and lost a full exterior repaint".
         * We built the guard against reading a reaction as text and then
         * did not give it the one input that makes it work.
         *
         * Same derivation the sandbox uses — an intent starting `ask_` is a
         * request for information — so the two cannot answer differently.
         */
        lastAskedForInfo: /^ask_/.test(priorIntents[priorIntents.length - 1] ?? ""),
        /**
         * A44 — which of the three follow-ups this is, so the model knows it
         * is writing one. Without it a follow-up reads as a fresh "just
         * checking in", which is the Hatch behaviour the capability replaces.
         */
        followUpStep: a.action === "stall_followup"
          ? (a.stall_step ?? undefined)
          : undefined,
        // A3 is satisfied by events, so the check needs the whole list
        // rather than just the last one.
        priorIntents,
        // The project-details leg, for the customer who described the job
        // themselves — no intent may legally fire for them. See A3_LEGS.
        scopeFromCustomer: resolved.scopeFrom === "customer",
        serviceArea: service?.outcome ?? null,
        zip: (conv as { customer_zip?: string | null }).customer_zip ?? null,
        stateName: service?.outcome === "out_of_state" ? service.state : null,
        // A25's phone branch. Kate, 2026-09-18: "Ending without capturing
        // when to call is the defect" — so a call request only hands over
        // once we hold a time, and asks for one when we do not. Read from
        // the conversation because it is A44's stated constraint, which does
        // not expire and does not need repeating.
        callback: {
          unreachableStartHour:
            (conv as { unreachable_start_hour?: number | null }).unreachable_start_hour ?? null,
        },
        // Their zone, for the week-aware availability ask and anything else
        // that needs to know what day it is where they are.
        customerZone: customerZone({ phone: conv.customer_phone }).timeZone,
        /**
         * A46: IS PPP OPEN? Not "could we have sent proactively right now".
         *
         * The disclosure's approved text is "I can take your project details
         * and pass them along ONCE WE OPEN", which is a claim about the office.
         * This used to be `!sendingWindow(...).open`, which is false when
         * EITHER window is shut — including when it is merely too early on the
         * CUSTOMER's clock.
         *
         * Those come apart for one hour every day for anybody west of Eastern.
         * A Los Angeles customer texting at 8:30 AM was told we would pass
         * their details along once we open, at 11:30 AM Eastern with the office
         * open. Daily, on the CA and CO workspaces, in approved compliance
         * copy. Impossible to hit from an Eastern customer, which is why it
         * survived: at 8:30 Eastern the office genuinely is shut.
         *
         * The customer's clock still decides whether we may SEND — the gate is
         * unchanged and still refuses a 6:30 AM text.
         */
        /**
         * Shut to THIS customer: the office is closed, or their own day has
         * ended. See recipientDayIsOver for why neither half is enough alone
         * — the previous version failed Kate's own acceptance test ("7:30 PM
         * Eastern: a CA lead gets in-hours behaviour, an ET lead gets the
         * prefix") because it asked only whether the office was open, which
         * at 7:30 PM it is. The spec is explicit that a single global "are we
         * open" flag "gets two of the six states wrong every evening".
         */
        outOfHours:
          !officeIsOpen({ now: new Date(), officeZone: ws.time_zone })
          || recipientDayIsOver({
            now: new Date(),
            customerZone: customerZone({ phone: conv.customer_phone }).timeZone,
          }),
        known: {
          name: conv.customer_name, phone: conv.customer_phone,
          // The RESOLVED email, not just the column — the one they typed this
          // turn counts before the write above has been read back.
          email: resolved.email,
          // THE FIELDS THE RULES ACTUALLY READ. Until 2026-09-23 these were
          // never passed, so kf.address and kf.inquiryScope were always null
          // and every rule built on them was code that could not fire: A11's
          // address gap, A6 and A7's job routing, A9's placeholder check, and
          // the confirm_address and confirm_scope turns, which can only
          // render when there is a value to read back.
          //
          // Cast because the columns are newer than the generated types, and
          // undefined when the migration has not been applied — which is the
          // old behaviour, not a crash.
          address: resolved.address,
          inquiryScope: resolved.inquiryScope,
        },
        services: resolveServices(svc.services, svc.exceptions),
        /**
         * THE WHOLE CORPUS, and runAgentTurn picks.
         *
         * This was `selectExamples(corpus, { stage })` — the stage and nothing
         * else — while the sandbox passed the situation as well. selectExamples
         * keeps only examples scoring above zero against the context given, so
         * in every real conversation the photo, reaction, "are you a bot",
         * callback, service-area and off-site examples scored zero and were
         * dropped. Kate graded those and the model has never seen one.
         *
         * The selection happens inside runAgentTurn now, off the inbound
         * message it has already normalised, so there is no longer a version of
         * this for the two callers to disagree about.
         */
        corpus,
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
        if (!agentFailureIsTransient(res)) {
          // A REJECTION HANDS OVER. It does not vanish.
          //
          // Retrying is pointless — the validator will refuse the same choice
          // next minute — but closing the turn quietly means the customer
          // gets silence and nobody is told. That is worse than the defect
          // being refused: the bot asking the wrong thing is bad, the bot
          // saying nothing at all is a conversation that dies unread.
          //
          // It matters most for the refusals added on this branch. A29 stops
          // a turn that ignores a direct question, A3 stops a close with the
          // details uncollected, A2 stops a promise of coverage for a zip we
          // cannot confirm. Every one of those is a moment a PERSON can
          // resolve in seconds by reading the thread, and every one of them
          // was being cancelled into silence instead.
          //
          // human_active with no owner IS the "Needs a person" queue, the
          // same door the turn leash uses.
          // "the bot was unsure and escalated itself" — which is exactly what
          // a refused turn is.
          await handToAPerson(sb, conv.id, "low_confidence");
          return { kind: "skipped" as const, reason: `handed to a person: ${res.rejected}`, retryable: true };
        }
        throw new Error(`the agent could not produce a reply: ${res.error}`);
      }
      if (!res.rendered.trim()) {
        // Same reasoning: a turn that renders nothing is a customer waiting.
        await handToAPerson(sb, conv.id, "low_confidence");
        return { kind: "skipped" as const, reason: "handed to a person: the agent had nothing to say", retryable: true };
      }

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
        //
        // THROWS IF THE DRAFT CANNOT BE WRITTEN, like the hold twelve lines
        // above. This discarded its error and then returned "drafted", which
        // marks the action done — so a failed insert meant no message, no
        // draft and a closed action: the customer's text answered by nobody,
        // permanently, with the tick reporting a draft.
        const { error: draftErr } = await sb.from("sms_drafts").insert({
          conversation_id: conv.id, answers_message_id: lastInbound.id,
          intent: res.action.intent, confidence: res.action.confidence,
          body: res.rendered, review_reason: "autosend_off",
          send_error: sent.reason,
        });
        if (draftErr) throw new Error(`could not write the refused reply as a draft: ${draftErr.message}`);
        return { kind: "drafted" as const };
      }

      const reason = res.escalate ? "escalated" : "autosend_off";

      // An escalation that only files a draft leaves the conversation looking
      // like the bot is still working it, and the "Needs human" bucket empty.
      // Moving it to human_active with no owner IS that queue: needed by
      // somebody, claimed by nobody. The reason is the little the agent can
      // actually attribute — a person claiming it says what it really was.
      if (res.escalate) {
        await handToAPerson(sb, conv.id, takeoverReasonFor({
          intent: res.action.intent,
          confidence: res.action.confidence,
          threshold: cfg.cfg.confidence_threshold,
        }));
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
        .select("id, customer_phone, sms_sub_accounts(id, name, phone_e164, origination_identity, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends, send_on_holidays)")
        .eq("id", a.conversation_id).maybeSingle();
      if (!conv) return { kind: "skipped" as const, reason: "conversation no longer exists" };
      const ws = conv.sms_sub_accounts as unknown as {
        id: string; name: string; phone_e164: string | null; origination_identity: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean; send_on_holidays: boolean;
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
      // becomes a draft for a person, the same as an autosend refusal always has
      // — and the insert is checked, for the reason given on its twin above:
      // returning "drafted" closes the action, so a silent failure here loses
      // the reply altogether.
      const { error: heldDraftErr } = await sb.from("sms_drafts").insert({
        conversation_id: conv.id, answers_message_id: a.answers_message_id,
        intent: a.reply_intent, confidence: a.reply_confidence,
        body: a.reply_body, review_reason: "autosend_off", send_error: sent.reason,
      });
      if (heldDraftErr) throw new Error(`could not write the held reply as a draft: ${heldDraftErr.message}`);
      return { kind: "drafted" as const };
    },

    async markDone(a) {
      await sb.from("sms_scheduled_actions").update({ state: "done", updated_at: new Date().toISOString() }).eq("id", a.id);
    },

    /**
     * CLOSING THE ROW IS THE OTHER HALF OF SENDING, AND IT WAS UNCHECKED.
     *
     * The carrier has accepted the message by the time this runs. The update
     * below discarded its error — postgrest-js returns `{ error }` rather than
     * throwing — so a timeout, an RLS change or a dropped connection left the
     * row `claimed` while the tick reported `sent: 1`.
     *
     * sms_reclaim_stale_actions then returns any row still claimed after ten
     * minutes to `pending`, deliberately WITHOUT refunding the attempt (see
     * migration 183, which is right to: a worker that died mid-send must not
     * retry for ever). The next tick picks it up and sends the same text
     * again. Up to five times.
     *
     * So the close is checked, retried once, and if it still will not go
     * through the row is marked FAILED rather than left for the reclaim. A
     * failed row is terminal and is never re-sent: losing a follow-up is a
     * great deal better than texting somebody the same thing five times, and
     * the alert says exactly what happened.
     *
     * What this cannot fix is a database that is entirely unreachable — then
     * even the failed write fails and the reclaim will re-send. Closing that
     * needs an idempotency key the carrier can be asked about, which is a
     * decision about what "unknown" means after a send, not a patch.
     */
    async markSent(a, providerId, body, channel = "sms", intent) {
      // THE INTENT, on the message. A held reply carries it on the action
      // row; an immediate autosend passes it in. A campaign step has none,
      // and a person's own words have none — both correctly null.
      const agentIntent = intent ?? a.reply_intent ?? null;
      // First, so there is a record of the message even if everything after
      // this fails. recordOutbound warns rather than throwing, by design.
      await recordOutbound(sb, {
        conversation_id: a.conversation_id, body, provider_id: providerId,
        channel, agent_intent: agentIntent,
      });

      const close = () => sb.from("sms_scheduled_actions")
        .update({ state: "done", updated_at: new Date().toISOString() })
        .eq("id", a.id);
      let { error } = await close();
      if (error) ({ error } = await close());
      if (error) {
        const { error: failErr } = await sb.from("sms_scheduled_actions").update({
          state: "failed",
          last_error: `sent, but the row could not be closed: ${error.message}`,
          updated_at: new Date().toISOString(),
        }).eq("id", a.id);
        reportWarn({
          key: "sms_sent_not_closed", platform: "ppp_cc",
          message: failErr
            ? "a message was SENT and the action could not be closed or failed — the reclaim will send it again"
            : "a message was sent and the action could not be closed; marked failed so it is not sent again",
          context: {
            conversationId: a.conversation_id, actionId: a.id, providerId,
            error: error.message, failError: failErr?.message ?? null,
          },
        });
      }

      // Neither of these can cause a re-send, so a failure here is reported
      // and does not change the outcome of the send.
      const { error: convErr } = await sb.from("sms_conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", a.conversation_id);
      if (convErr) {
        reportWarn({
          key: "sms_last_message_at_not_updated", platform: "ppp_cc",
          message: "a message went out and the conversation's last_message_at was not updated",
          context: { conversationId: a.conversation_id, error: convErr.message },
        });
      }
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
