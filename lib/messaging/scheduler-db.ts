/**
 * Supabase-backed ports for the scheduler worker.
 *
 * The worker itself is pure and injected; this is the only place that touches
 * the database, so every branch stays testable without one.
 */
import { messagingDb } from "./db";
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
      let agent = "campaign";
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
      return gatedSend(req, {
        async isSuppressed(to) {
          const { data } = await sb
            .from("sms_opt_outs").select("phone_e164")
            .eq("phone_e164", to).is("opted_in_at", null).maybeSingle();
          return !!data;
        },
        async sentToday(to) {
          // Across every agent and workspace — the cap belongs to the handset.
          const since = new Date(Date.now() - 24 * 3600_000).toISOString();
          const { data } = await sb
            .from("sms_conversations").select("id").eq("customer_phone", to);
          const ids = (data ?? []).map((c) => c.id);
          if (!ids.length) return 0;
          const { count } = await sb
            .from("sms_messages").select("id", { count: "exact", head: true })
            .in("conversation_id", ids).eq("direction", "outbound").gte("created_at", since);
          return count ?? 0;
        },
      });
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
