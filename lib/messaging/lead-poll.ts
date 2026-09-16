/**
 * New Salesforce Leads, polled onto the tick, and put into campaigns.
 *
 * Karan, 2026-09-15: poll now rather than wait for Katie's Flow webhook. Both
 * write sf_lead_inbound, whose sf_record_id is UNIQUE, so when the webhook
 * lands a lead arriving twice is a no-op and the poll becomes the safety net.
 *
 * At most once a minute however often the tick runs: 171 leads a day do not
 * need a Salesforce query every ten seconds, and the first message is timed
 * from Salesforce's CreatedDate, so the poll's lag is inside the 2-5 minutes
 * rather than added to it.
 *
 * READ-ONLY against Salesforce. Nothing here writes to it.
 *
 * Nothing is texted by this. It enrols into ACTIVE workflows only (all are
 * off until somebody turns one on), and sending is the gate's decision with
 * its own switches.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decideIntake } from "./lead-intake";
import { leadFromSalesforce, LEAD_FIELDS, type SalesforceLead } from "./lead-map";
import { enrolLeadWith } from "./enrol-core";
import { toE164 } from "./phone";

/** Never look further back than this, however stale sf_poll_state is. A first
 *  run against a months-old watermark must not pull months of leads. */
const MAX_LOOKBACK_MS = 60 * 60 * 1000;
/** Re-read the last few minutes each time; a lead committed late is caught,
 *  and the unique index makes the overlap free. */
const OVERLAP_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 1000;

export type PollSummary = {
  polled: boolean;
  found: number;
  inserted: number;
  routed: number;
  triaged: number;
  ignored: number;
  failed: number;
  why?: string;
};

type Query = (soql: string) => Promise<{ records: SalesforceLead[] }>;

export async function pollSalesforceLeads(sb: SupabaseClient, query: Query, now = new Date()): Promise<PollSummary> {
  const summary: PollSummary = { polled: false, found: 0, inserted: 0, routed: 0, triaged: 0, ignored: 0, failed: 0 };

  const { data: state } = await sb.from("sf_poll_state").select("last_polled_at").eq("id", true).maybeSingle();
  const last = state?.last_polled_at ? new Date(state.last_polled_at) : new Date(0);
  if (now.getTime() - last.getTime() < MIN_INTERVAL_MS) {
    return { ...summary, why: "polled less than a minute ago" };
  }

  const since = new Date(Math.max(last.getTime() - OVERLAP_MS, now.getTime() - MAX_LOOKBACK_MS));
  const soql = `SELECT ${LEAD_FIELDS.join(", ")} FROM Lead WHERE CreatedDate > ${since.toISOString()} ORDER BY CreatedDate LIMIT 200`;
  const res = await query(soql);
  summary.polled = true;
  summary.found = res.records.length;

  if (res.records.length) {
    const rows = res.records.map((r) => {
      const { lead } = leadFromSalesforce(r);
      return {
        sf_record_id: r.Id, sf_object: "Lead", arrived_via: "poll",
        payload: r, phone_e164: toE164(lead.phone ?? null), email: lead.email,
        full_name: lead.fullName, lead_source: lead.leadSource, state_code: lead.state,
        locality: lead.locality, sf_created_at: lead.sfCreatedAt,
      };
    });
    const { data: ins, error } = await sb.from("sf_lead_inbound")
      .upsert(rows, { onConflict: "sf_record_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`could not record leads: ${error.message}`);
    summary.inserted = ins?.length ?? 0;
  }

  await sb.from("sf_poll_state").update({
    last_polled_at: now.toISOString(), last_run_found: summary.found, updated_at: now.toISOString(),
  }).eq("id", true);

  const processed = await processPendingLeads(sb, now);
  return { ...summary, ...processed };
}

/**
 * Route and enrol whatever is pending, from the poll or (later) the webhook.
 * Each lead ends with a status and, when it did not enter a campaign, why.
 */
export async function processPendingLeads(sb: SupabaseClient, now = new Date()) {
  const out = { routed: 0, triaged: 0, ignored: 0, failed: 0 };
  const { data: pending } = await sb.from("sf_lead_inbound")
    .select("id, payload").eq("status", "pending").order("received_at").limit(50);
  if (!pending?.length) return out;

  const { data: workspaces } = await sb.from("sms_sub_accounts").select("id, name, is_active, phone_e164");
  const phones = pending
    .map((p) => toE164(leadFromSalesforce(p.payload as SalesforceLead).lead.phone ?? null))
    .filter(Boolean) as string[];
  const { data: optOuts } = phones.length
    ? await sb.from("sms_opt_outs").select("phone_e164").in("phone_e164", phones)
    : { data: [] as { phone_e164: string }[] };
  const suppressed = new Set((optOuts ?? []).map((o) => o.phone_e164));

  for (const p of pending) {
    const set = (patch: Record<string, unknown>) =>
      sb.from("sf_lead_inbound").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", p.id);
    try {
      const { lead, record } = leadFromSalesforce(p.payload as SalesforceLead);
      const decision = decideIntake(lead, {
        workspaces: workspaces ?? [],
        isSuppressed: (ph) => suppressed.has(ph),
      });

      if (decision.action === "ignore") {
        await set({ status: "ignored", triage_reason: decision.reason });
        out.ignored++;
        continue;
      }
      if (decision.action === "triage") {
        await set({ status: "triage", triage_reason: `${decision.reason}: ${decision.detail}` });
        out.triaged++;
        continue;
      }

      const enrolled = await enrolLeadWith(sb, {
        workspaceId: decision.workspaceId,
        customerPhone: decision.phone,
        customerName: lead.fullName,
        customerEmail: lead.email,
        sfLeadId: lead.sfRecordId,
        record,
        leadCreatedAt: lead.sfCreatedAt ? new Date(lead.sfCreatedAt) : null,
        now,
      });
      if (!enrolled.ok) {
        // Routed to a workspace but not into a campaign: most often because no
        // workflow there is switched on yet. Recorded, not retried every tick.
        await set({ status: "ignored", workspace_id: decision.workspaceId, triage_reason: enrolled.reason });
        out.ignored++;
        continue;
      }
      await set({
        status: "routed", workspace_id: decision.workspaceId, conversation_id: enrolled.conversationId,
        first_message_at: enrolled.firstMessageAt ?? null, triage_reason: null,
      });
      out.routed++;
    } catch (err) {
      await set({ status: "failed", triage_reason: err instanceof Error ? err.message : String(err) });
      out.failed++;
    }
  }
  return out;
}
