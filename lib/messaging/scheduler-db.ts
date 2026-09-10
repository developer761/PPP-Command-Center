/**
 * Supabase-backed ports for the scheduler worker.
 *
 * The worker itself is pure and injected; this is the only place that touches
 * the database, so every branch stays testable without one.
 */
import { messagingDb } from "./db";
import { gateDeps } from "./gate-deps";
import { toE164 } from "./phone";
import { agentConfigFor } from "./agent-config-for";
import { loadRetrievalCorpus, loadWorkspaceServices } from "./db";
import { runAgentTurn } from "./agent-run";
import { stageFromIntents } from "./agent-output";
import { resolveServices } from "./services";
import { selectExamples } from "./retrieval";
import { gatedSend, type GateResult, type SendRequest } from "./gate";
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
        .select("state, customer_phone, sms_sub_accounts(id, name, phone_e164, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
        .eq("id", a.conversation_id)
        .maybeSingle();
      if (!data) return null;
      const ws = data.sms_sub_accounts as unknown as {
        id: string; name: string; phone_e164: string | null; time_zone: string;
        quiet_hours_start: number; quiet_hours_end: number; send_on_weekends: boolean;
      } | null;
      if (!ws) return null;

      let body = "";
      const agent = "campaign";
      if (a.campaign_step_id) {
        const { data: step } = await sb
          .from("sms_campaign_steps").select("body").eq("id", a.campaign_step_id).maybeSingle();
        body = step?.body ?? "";
      }
      return {
        workspace: ws,
        to: data.customer_phone as E164,
        body, agent,
        conversationState: data.state as string,
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
        .select("id, state, customer_phone, customer_name, customer_email, workspace_id, sms_sub_accounts(id, name, autosend_enabled, phone_e164, time_zone, quiet_hours_start, quiet_hours_end, send_on_weekends)")
        .eq("id", a.conversation_id).maybeSingle();
      if (!conv) return { kind: "skipped" as const, reason: "conversation no longer exists" };
      if (conv.state === "ended") return { kind: "skipped" as const, reason: "conversation has ended" };

      const ws = conv.sms_sub_accounts as unknown as {
        id: string; name: string; autosend_enabled: boolean;
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
        .select("id, direction, body, created_at")
        .eq("conversation_id", conv.id).order("created_at");
      const history = (msgs ?? []).map((m) => ({
        role: (m.direction === "inbound" ? "customer" : "assistant") as "customer" | "assistant",
        text: m.body,
      }));
      const lastInbound = [...(msgs ?? [])].reverse().find((m) => m.direction === "inbound");
      if (!lastInbound) return { kind: "skipped" as const, reason: "nothing to reply to" };

      // Everything the sandbox resolves, resolved the same way.
      const [cfg, corpus, svc] = await Promise.all([
        agentConfigFor(conv.workspace_id),
        loadRetrievalCorpus(),
        loadWorkspaceServices(conv.workspace_id),
      ]);
      if (!cfg) return { kind: "skipped" as const, reason: "no agent configuration" };

      const priorIntents = (await sb.from("sms_drafts")
        .select("intent").eq("conversation_id", conv.id).order("created_at")).data ?? [];

      const res = await runAgentTurn(cfg.cfg, history.slice(0, -1), lastInbound.body, {
        hardNos: cfg.hardNos,
        stage: stageFromIntents(priorIntents.map((p) => p.intent)),
        lastIntent: priorIntents[priorIntents.length - 1]?.intent ?? undefined,
        known: {
          name: conv.customer_name, phone: conv.customer_phone, email: conv.customer_email,
        },
        services: resolveServices(svc.services, svc.exceptions),
        examples: selectExamples(corpus, { stage: stageFromIntents(priorIntents.map((p) => p.intent)) }),
      });

      if (!res.ok) return { kind: "skipped" as const, reason: res.rejected ?? res.error };
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
        const sent = await gatedSend(
          { workspace: wsFull, to, body: res.rendered, agent: "agent_autosend" },
          gateDeps(sb)
        );
        if (sent.ok) {
          return { kind: "sent" as const, providerId: sent.providerId, body: sent.body };
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

    async markSent(a, providerId, body) {
      await sb.from("sms_messages").insert({
        conversation_id: a.conversation_id, direction: "outbound",
        body, provider_id: providerId, delivery_status: "sent",
      });
      await sb.from("sms_scheduled_actions").update({ state: "done", updated_at: new Date().toISOString() }).eq("id", a.id);
      await sb.from("sms_conversations").update({ last_message_at: new Date().toISOString() }).eq("id", a.conversation_id);
    },

    async reschedule(a, at, reason) {
      await sb.from("sms_scheduled_actions").update({
        state: "pending", claimed_at: null, run_at: at.toISOString(),
        last_error: reason, updated_at: new Date().toISOString(),
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
