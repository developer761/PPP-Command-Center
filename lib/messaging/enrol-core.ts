/**
 * Putting a lead into a campaign, and taking it out again: the work itself.
 *
 * Split out of enrol-db.ts (the "use server" actions) on 2026-09-15 because
 * the Salesforce lead poll runs on the tick, with no signed-in user, and the
 * actions start with assertMessagingAccess(), which redirects when there is
 * nobody. The actions still check the caller and then call these; the tick
 * calls these directly. Nothing here is reachable from a browser, because this
 * file is not a server-action module.
 *
 * The chain: decideIntake says WHICH WORKSPACE, chooseWorkflow says WHICH
 * CAMPAIGN, scheduleSteps says WHEN each message goes, and the scheduler sends
 * them through the gate. Every refusal is returned with a reason: a lead that
 * quietly did not enter a campaign is indistinguishable from one the system
 * never received.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseWorkflow, shouldExit, type Workflow } from "./enrollment";
import { scheduleSteps, firstMessageAt, type CampaignStep } from "./campaign-schedule";
import { TICK_SECONDS } from "./reply-delay";
import type { LeadRecord, Rule } from "./rules";
import { toE164 } from "./phone";
import { trackForWorkspace } from "./track";
import { selectAllIn } from "./paging";

export type EnrolResult =
  | {
      ok: true; conversationId: string; workflow: string; stepsScheduled: number;
      alreadyLive?: boolean; firstMessageAt?: string;
      /**
       * Other workflows whose entry rules ALSO matched this lead.
       *
       * chooseWorkflow has always worked this out and said why: "Two workflows
       * matching one lead means the audiences overlap, which is a
       * configuration mistake rather than a choice to make at runtime — and
       * picking one silently would hide it. The overlap is reported so
       * somebody can fix the filters."
       *
       * It was not reported. The value was computed, returned, and read by
       * nothing, so the first workflow in the list quietly won and which
       * campaign a customer got depended on row order. Carried out to the poll
       * now, which is the only thing watching.
       */
      alsoMatched?: string[];
    }
  | { ok: false; reason: string };

/** Workflows for one workspace, with their rule sets loaded. */
export async function workflowsFor(sb: SupabaseClient, workspaceId: string): Promise<Workflow[]> {
  const { data: rows } = await sb
    .from("sms_workflows")
    .select("id, name, campaign_id, workspace_id, entry_rules_id, exit_rules_id, is_active")
    .eq("workspace_id", workspaceId);
  if (!rows?.length) return [];

  const setIds = [...new Set(rows.flatMap((r) => [r.entry_rules_id, r.exit_rules_id]).filter(Boolean))] as string[];
  const { data: rules } = setIds.length
    ? await sb.from("sms_rules").select("rule_set_id, field, operator, values").in("rule_set_id", setIds).order("ordinal")
    : { data: [] as { rule_set_id: string; field: string; operator: string; values: unknown }[] };

  const bySet = new Map<string, Rule[]>();
  for (const r of rules ?? []) {
    const list = bySet.get(r.rule_set_id) ?? [];
    list.push({ field: r.field, operator: r.operator as Rule["operator"], values: (r.values ?? []) as unknown[] });
    bySet.set(r.rule_set_id, list);
  }

  return rows.map((r) => ({
    id: r.id, name: r.name, workspaceId: r.workspace_id, campaignId: r.campaign_id,
    entryRules: r.entry_rules_id ? bySet.get(r.entry_rules_id) ?? [] : [],
    exitRules: r.exit_rules_id ? bySet.get(r.exit_rules_id) ?? [] : [],
    isActive: r.is_active,
  }));
}

/** The published steps of a campaign's newest version. */
async function publishedSteps(sb: SupabaseClient, campaignId: string): Promise<{
  versionId: string; steps: CampaignStep[];
} | null> {
  const { data: version } = await sb
    .from("sms_campaign_versions").select("id")
    .eq("campaign_id", campaignId).not("published_at", "is", null)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (!version) return null;

  const { data: steps } = await sb
    .from("sms_campaign_steps")
    .select("ordinal, schedule_mode, delay_minutes, day_offset, time_of_day, channel, body, subject")
    .eq("version_id", version.id).order("ordinal");

  return {
    versionId: version.id,
    steps: (steps ?? []).map((s) => ({
      ordinal: s.ordinal,
      scheduleMode: s.schedule_mode as CampaignStep["scheduleMode"],
      delayMinutes: s.delay_minutes, dayOffset: s.day_offset, timeOfDay: s.time_of_day,
      channel: s.channel as "sms" | "email", body: s.body, subject: s.subject,
    })),
  };
}

export async function enrolLeadWith(sb: SupabaseClient, input: {
  workspaceId: string;
  customerPhone: string;
  customerName?: string | null;
  customerEmail?: string | null;
  /**
   * What the lead told us, carried onto the conversation so a reply can read
   * it without following a chain back to the lead row.
   *
   * These existed nowhere until 2026-09-23, which is why the bot asked for an
   * address the record already held (A13) and never routed a job off-site
   * (A6/A7): the fields the rules read were always null.
   */
  customerAddress?: string | null;
  customerZip?: string | null;
  inquiryScope?: string | null;
  sfLeadId?: string | null;
  /** The Salesforce record, for the entry rules to read. */
  record: LeadRecord;
  /** When Salesforce created the lead. The opener is timed from this. */
  leadCreatedAt?: Date | null;
  now?: Date;
  rand?: () => number;
}): Promise<EnrolResult> {
  const now = input.now ?? new Date();

  const to = toE164(input.customerPhone);
  if (!to) return { ok: false, reason: `"${input.customerPhone}" is not a usable phone number` };

  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, time_zone, is_active").eq("id", input.workspaceId).maybeSingle();
  if (!ws) return { ok: false, reason: "that workspace does not exist" };
  if (!ws.is_active) return { ok: false, reason: `${ws.name} is not live` };

  const decision = chooseWorkflow(await workflowsFor(sb, ws.id), input.record, now);
  if (!decision.enrol) return { ok: false, reason: decision.reason };

  const steps = await publishedSteps(sb, decision.workflow.campaignId);
  if (!steps || steps.steps.length === 0) {
    return { ok: false, reason: `${decision.workflow.name} has no published steps to send` };
  }

  // ALREADY TALKING TO THEM. One live conversation per person per workspace,
  // and a duplicate lead is common: the same person filling the form twice,
  // or Salesforce firing twice. A second campaign on top would text everything
  // twice.
  const { data: live } = await sb.from("sms_conversations")
    .select("id").eq("workspace_id", ws.id).eq("customer_phone", to)
    .neq("state", "ended").maybeSingle();
  const alsoMatched = decision.alsoMatched?.length ? decision.alsoMatched : undefined;

  if (live) {
    return {
      ok: true, conversationId: live.id, workflow: decision.workflow.name,
      stepsScheduled: 0, alreadyLive: true, alsoMatched,
    };
  }

  const { data: conv, error: convErr } = await sb.from("sms_conversations").insert({
    workspace_id: ws.id,
    customer_phone: to,
    customer_name: input.customerName ?? null,
    customer_email: input.customerEmail ?? null,
    customer_address: input.customerAddress ?? null,
    customer_zip: input.customerZip ?? null,
    inquiry_scope: input.inquiryScope ?? null,
    sf_lead_id: input.sfLeadId ?? null,
    campaign_version_id: steps.versionId,
    state: "ai_active",
    // 'inquiry', which is what the CHECK allows. This said 'inbound_inquiry',
    // which it does not, so every enrolment ever attempted would have failed
    // at this insert. Nothing called this until the lead poll.
    consent_basis: "inquiry",
    // WHICH CONVERSATION THIS IS. Migration 196 named the rule — AM
    // workspaces carry nurture, Leads and Meta carry new leads — and nothing
    // ever applied it, so every AM conversation ran the NEW LEAD prompt and
    // asked a customer already holding a written quote for their address.
    track: trackForWorkspace(ws.name),
  }).select("id").single();
  if (convErr) return { ok: false, reason: `could not open a conversation: ${convErr.message}` };

  const launchAt = firstMessageAt({
    leadCreatedAt: input.leadCreatedAt ?? null, now, tickSeconds: TICK_SECONDS, rand: input.rand,
  });
  const planned = scheduleSteps(steps.steps, now, ws.time_zone ?? "America/New_York", { launchAt });
  const byOrdinal = new Map(steps.steps.map((s) => [s.ordinal, s]));

  const { data: stepRows } = await sb.from("sms_campaign_steps")
    .select("id, ordinal").eq("version_id", steps.versionId);
  const idOf = new Map((stepRows ?? []).map((s) => [s.ordinal, s.id]));

  const rows = planned
    .filter((p) => byOrdinal.has(p.ordinal))
    .map((p) => ({
      conversation_id: conv.id,
      campaign_step_id: idOf.get(p.ordinal) ?? null,
      action: "send_step",
      run_at: p.runAt.toISOString(),
    }));

  const { error: qErr } = await sb.from("sms_scheduled_actions").insert(rows);
  if (qErr) {
    // A conversation without its steps is a customer who will never hear from
    // us, which is worse than not having started. Undo it.
    await sb.from("sms_conversations").delete().eq("id", conv.id);
    return { ok: false, reason: `could not schedule the campaign: ${qErr.message}` };
  }

  return {
    ok: true, conversationId: conv.id,
    workflow: decision.workflow.name, stepsScheduled: rows.length,
    firstMessageAt: launchAt.toISOString(),
    alsoMatched,
  };
}

/**
 * Take out anyone whose exit rules now match.
 *
 * Runs on the tick rather than on a Salesforce event, because the interesting
 * exits happen elsewhere: an estimator books the appointment in Salesforce and
 * nothing tells us. Polling for it is how the chase stops.
 */
export async function sweepExitsWith(sb: SupabaseClient, input: {
  /** The current Salesforce state, keyed by conversation id. */
  records: Record<string, LeadRecord>;
  now?: Date;
}): Promise<{ ended: number; reasons: Record<string, string> }> {
  const now = input.now ?? new Date();
  const ids = Object.keys(input.records);
  if (!ids.length) return { ended: 0, reasons: {} };

  // Paged: a truncated read here does not misreport anything, it simply
  // leaves every conversation past the thousandth un-ended, which is a live
  // sequence still texting somebody the records say is done.
  const convs = await selectAllIn<{ id: string; workspace_id: string; state: string }>(
    ids,
    (chunk, from, to) => sb.from("sms_conversations")
      .select("id, workspace_id, state").in("id", chunk).neq("state", "ended")
      .order("id").range(from, to),
    "conversations to end"
  );

  const reasons: Record<string, string> = {};
  let ended = 0;
  const cache = new Map<string, Workflow[]>();

  for (const c of convs ?? []) {
    const workflows = cache.get(c.workspace_id) ?? await workflowsFor(sb, c.workspace_id);
    cache.set(c.workspace_id, workflows);
    const record = input.records[c.id];
    for (const w of workflows) {
      const d = shouldExit(w, record, now);
      if (!d.exit) continue;

      await sb.from("sms_conversations").update({
        state: "ended", outcome: "success", ended_at: new Date().toISOString(),
      }).eq("id", c.id);

      // Everything still queued stops. The trigger from migration 181 does
      // this too; doing it here as well means the reason is recorded.
      await sb.from("sms_scheduled_actions").update({
        state: "cancelled", cancelled_reason: `exit rule: ${d.reason}`,
      }).eq("conversation_id", c.id).in("state", ["pending", "claimed"]);

      reasons[c.id] = d.reason;
      ended++;
      break;
    }
  }
  return { ended, reasons };
}
