/**
 * Stop chasing people who already booked.
 *
 * sweepExitsWith has existed since enrolment was built, and it works — it was
 * simply never called. Nothing in the tick, no page, no API route. Meanwhile
 * /messaging/automations renders the seeded exit rule set under the heading
 * "And it stops when…", as a promise to whoever reads it. The only thing that
 * has ever ended a conversation is an inbound STOP, so a customer who books an
 * estimate gets the full sequence anyway: the day-1 chase, the day-3 chase,
 * all of it, after somebody has already been to their house.
 *
 * This is the half that was missing: sweepExitsWith wants the CURRENT
 * Salesforce state keyed by conversation, and nothing built it.
 *
 * WHY POLLING. The interesting exits happen in Salesforce, not here. An
 * estimator books an appointment and nothing tells us; a lead is marked
 * Qualified and nothing tells us. There is no push path, so the only way to
 * find out is to ask.
 *
 * Every field below was checked against the live org on 2026-09-21 rather than
 * assumed: Lead.ConvertedOpportunityId, Opportunity.StageName and
 * Opportunity.AppointmentDate__c all exist, Lead.Status really does carry
 * "Qualified" and "Unqualified", and SMS_Opt_In__c really does carry
 * "Opt-Out". The seeded rules reference Opportunity.* on a Lead, which is not
 * a thing SOQL can traverse, which is why this reads the Opportunity in a
 * second query and nests it where readField can find it.
 *
 * READ ONLY against Salesforce. It runs two SELECTs and writes nothing there.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadRecord } from "./rules";
import { sweepExitsWith } from "./enrol-core";

/** Lead fields the seeded exit rules read, plus the link to the Opportunity. */
export const EXIT_LEAD_FIELDS = [
  "Id", "Status", "IsConverted", "SMS_Opt_In__c", "ConvertedOpportunityId",
] as const;

/** Opportunity fields the seeded exit rules read. */
export const EXIT_OPP_FIELDS = ["Id", "StageName", "AppointmentDate__c"] as const;

/** SOQL `IN` has a practical ceiling; ids are batched rather than sent as one
 *  enormous literal that the API rejects outright. */
export const ID_BATCH = 200;

/** How many live conversations one sweep looks at. A backlog is swept over
 *  several ticks rather than turning one tick into a long Salesforce job. */
export const SWEEP_LIMIT = 400;

/**
 * Not every tick. Campaign steps are hours or days apart, so asking Salesforce
 * every sixty seconds buys nothing and spends API calls PPP shares with the
 * rest of the business.
 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

export type SweepQuery = (soql: string) => Promise<{ records: Record<string, unknown>[] }>;

export type SweepSummary = {
  swept: boolean;
  /** Live conversations that came from a Salesforce lead. */
  considered: number;
  ended: number;
  reasons: Record<string, string>;
  why?: string;
};

export function batches<T>(items: T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Salesforce ids are alphanumeric; quoting them is still not a place to be
 *  casual, so anything that is not an id shape is dropped rather than escaped. */
export function idList(ids: string[]): string {
  return ids.filter((i) => /^[a-zA-Z0-9]{15,18}$/.test(i)).map((i) => `'${i}'`).join(", ");
}

/**
 * The record the exit rules evaluate, with the Opportunity nested.
 *
 * readField walks dotted paths as nested objects, so `Opportunity.StageName`
 * resolves against `{ Opportunity: { StageName } }`. A lead with no converted
 * opportunity gets no Opportunity key at all — which is what makes
 * `is_not_blank` on AppointmentDate__c correctly false rather than throwing.
 */
export function leadStateFor(
  leads: Record<string, unknown>[],
  opportunities: Record<string, unknown>[]
): Record<string, LeadRecord> {
  const oppById = new Map(opportunities.map((o) => [String(o.Id), o]));
  const out: Record<string, LeadRecord> = {};
  for (const l of leads) {
    const id = String(l.Id ?? "");
    if (!id) continue;
    const oppId = l.ConvertedOpportunityId ? String(l.ConvertedOpportunityId) : null;
    const opp = oppId ? oppById.get(oppId) : undefined;
    out[id] = { ...l, ...(opp ? { Opportunity: opp } : {}) } as LeadRecord;
  }
  return out;
}

/** Re-key Salesforce state by conversation, which is what sweepExitsWith wants. */
export function byConversation(
  links: { conversation_id: string | null; sf_record_id: string | null }[],
  bySfId: Record<string, LeadRecord>
): Record<string, LeadRecord> {
  const out: Record<string, LeadRecord> = {};
  for (const l of links) {
    if (!l.conversation_id || !l.sf_record_id) continue;
    const rec = bySfId[l.sf_record_id];
    if (rec) out[l.conversation_id] = rec;
  }
  return out;
}

/**
 * One sweep: find live conversations that came from a lead, ask Salesforce
 * what those leads look like now, and end the ones whose exit rules match.
 */
export async function sweepExitsFor(
  sb: SupabaseClient,
  query: SweepQuery,
  now = new Date()
): Promise<SweepSummary> {
  const empty: SweepSummary = { swept: false, considered: 0, ended: 0, reasons: {} };

  // TOLERATES ITS OWN MIGRATION NOT BEING APPLIED, which this repo requires of
  // anything reading a new column: migrations are pasted into the SQL editor by
  // hand, so there is always a window where the code is deployed and the column
  // is not there. A missing column returns 42703 rather than a row; the sweep
  // then runs unthrottled rather than not at all, and the watermark write below
  // is skipped for the same reason. Wrong-but-working beats a crash in the tick.
  const { data: state, error: stateErr } = await sb
    .from("sf_poll_state").select("last_swept_at").eq("id", true).maybeSingle();
  const throttled = !stateErr;
  const last = state?.last_swept_at ? new Date(state.last_swept_at) : new Date(0);
  if (throttled && now.getTime() - last.getTime() < SWEEP_INTERVAL_MS) {
    return { ...empty, why: "swept less than five minutes ago" };
  }
  const mark = async () => {
    if (!throttled) return;
    await sb.from("sf_poll_state").update({
      last_swept_at: now.toISOString(), updated_at: now.toISOString(),
    }).eq("id", true);
  };

  // Live conversations only. An ended one has nothing left to cancel.
  const { data: live, error: liveErr } = await sb.from("sms_conversations")
    .select("id").neq("state", "ended").limit(SWEEP_LIMIT);
  if (liveErr) throw new Error(`could not list live conversations: ${liveErr.message}`);
  const liveIds = (live ?? []).map((c) => c.id as string);
  if (!liveIds.length) {
    await mark();
    return { ...empty, swept: true, why: "no live conversations" };
  }

  const { data: links, error: linkErr } = await sb.from("sf_lead_inbound")
    .select("conversation_id, sf_record_id")
    .in("conversation_id", liveIds)
    .eq("sf_object", "Lead");
  if (linkErr) throw new Error(`could not match conversations to leads: ${linkErr.message}`);

  const sfIds = [...new Set((links ?? []).map((l) => l.sf_record_id as string).filter(Boolean))];
  if (!sfIds.length) {
    await mark();
    return { ...empty, swept: true, why: "no live conversation came from a Salesforce lead" };
  }

  const leads: Record<string, unknown>[] = [];
  for (const chunk of batches(sfIds)) {
    const list = idList(chunk);
    if (!list) continue;
    const res = await query(`SELECT ${EXIT_LEAD_FIELDS.join(", ")} FROM Lead WHERE Id IN (${list})`);
    leads.push(...res.records);
  }

  // Second query rather than a traversal: Opportunity.* is not reachable from
  // Lead in SOQL, and the seeded rules are written against it.
  const oppIds = [...new Set(leads.map((l) => l.ConvertedOpportunityId).filter(Boolean).map(String))];
  const opportunities: Record<string, unknown>[] = [];
  for (const chunk of batches(oppIds)) {
    const list = idList(chunk);
    if (!list) continue;
    const res = await query(`SELECT ${EXIT_OPP_FIELDS.join(", ")} FROM Opportunity WHERE Id IN (${list})`);
    opportunities.push(...res.records);
  }

  const records = byConversation(links ?? [], leadStateFor(leads, opportunities));
  const { ended, reasons } = await sweepExitsWith(sb, { records, now });

  await mark();

  return { swept: true, considered: Object.keys(records).length, ended, reasons };
}
