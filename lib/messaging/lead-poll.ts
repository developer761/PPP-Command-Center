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
import { territoryFor as territoryOf, zipIndex, normalizeZip, type ZipRow } from "./territory";
import { enrolLeadWith } from "./enrol-core";
import { toE164 } from "./phone";

/** Never look further back than this, however stale sf_poll_state is. A first
 *  run against a months-old watermark must not pull months of leads. */
const MAX_LOOKBACK_MS = 60 * 60 * 1000;
/** Re-read the last few minutes each time; a lead committed late is caught,
 *  and the unique index makes the overlap free. */
const OVERLAP_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 1000;
/** How many leads one poll reads. See the watermark note in pollSalesforceLeads. */
export const POLL_LIMIT = 200;

export type PollSummary = {
  polled: boolean;
  found: number;
  inserted: number;
  routed: number;
  triaged: number;
  ignored: number;
  failed: number;
  /** The batch came back full, so more is waiting and the watermark was held
   *  back rather than advanced to now. */
  more?: boolean;
  why?: string;
};

/**
 * `all: true` asks the caller to follow Salesforce's pagination.
 *
 * SOQL returns 2,000 records per batch and then stops. The zip map is 2,194
 * rows, so the first version of loadZipMap silently lost 194 of them — about
 * 9% of PPP's service area, whose leads would have fallen back to the city
 * and, for a split state, to triage. Found by printing the size of the map
 * next to the number Salesforce reports, which is the only reason it did not
 * ship looking fine.
 */
export type Query = (soql: string, opts?: { all?: boolean }) => Promise<{ records: SalesforceLead[] }>;

export async function pollSalesforceLeads(sb: SupabaseClient, query: Query, now = new Date()): Promise<PollSummary> {
  const summary: PollSummary = { polled: false, found: 0, inserted: 0, routed: 0, triaged: 0, ignored: 0, failed: 0 };

  const { data: state } = await sb.from("sf_poll_state").select("last_polled_at").eq("id", true).maybeSingle();
  const last = state?.last_polled_at ? new Date(state.last_polled_at) : new Date(0);
  if (now.getTime() - last.getTime() < MIN_INTERVAL_MS) {
    return { ...summary, why: "polled less than a minute ago" };
  }

  const since = new Date(Math.max(last.getTime() - OVERLAP_MS, now.getTime() - MAX_LOOKBACK_MS));
  const soql = `SELECT ${LEAD_FIELDS.join(", ")} FROM Lead WHERE CreatedDate > ${since.toISOString()} ORDER BY CreatedDate LIMIT ${POLL_LIMIT}`;
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

  // THE WATERMARK ONLY MOVES PAST WHAT WE ACTUALLY READ.
  //
  // The query takes 200 at a time, ordered oldest first. If it came back FULL
  // there are almost certainly more behind it, and setting the watermark to
  // `now` would step over every one of them — permanently, because nothing
  // looks backwards. A Data Loader import, a Flow backfill, or catching up
  // after an outage would silently lose every lead past the two-hundredth.
  //
  // So on a full batch the watermark goes to the newest lead we read, and the
  // next tick carries on from there. The 5-minute overlap re-reads a handful,
  // which the unique index makes free.
  const full = res.records.length >= POLL_LIMIT;
  const newest = res.records[res.records.length - 1]?.CreatedDate;
  const watermark = full && newest ? new Date(newest) : now;
  summary.more = full;

  await sb.from("sf_poll_state").update({
    last_polled_at: watermark.toISOString(), last_run_found: summary.found, updated_at: now.toISOString(),
  }).eq("id", true);

  const processed = await processPendingLeads(sb, now, query);
  return { ...summary, ...processed };
}

/**
 * PPP's zip map, fetched once and reused.
 *
 * 2,194 Zip_Code__c rows. Loaded per batch rather than per lead — fifty leads
 * would otherwise be fifty SOQL queries against an API PPP shares with the
 * rest of the business — and cached for an hour on top, because the map
 * changes when somebody opens a territory, not by the minute.
 *
 * Fails to an EMPTY map rather than throwing. Routing then falls back to the
 * city and state, which is worse but still refuses to guess between regions.
 * A Salesforce blip must not stop every lead in the batch.
 */
let zipCache: { index: Map<string, ZipRow>; at: number } | null = null;
const ZIP_TTL_MS = 60 * 60_000;

export function clearZipCache(): void {
  zipCache = null;
}

export async function loadZipMap(query: Query, now = Date.now()): Promise<Map<string, ZipRow>> {
  if (zipCache && now - zipCache.at < ZIP_TTL_MS) return zipCache.index;
  try {
    const res = (await query(
      "SELECT Zip_Code__c, City__c, State__c, County__c, Service_Territory__r.Name, " +
      "Service_Territory__r.IsActive FROM Zip_Code__c",
      { all: true }
    )) as unknown as { records: Record<string, unknown>[] };
    const rows: ZipRow[] = (res.records ?? []).map((r) => {
      const t = r.Service_Territory__r as { Name?: string; IsActive?: boolean } | null;
      return {
        zip: String(r.Zip_Code__c ?? ""),
        territoryName: t?.Name ?? null,
        territoryActive: !!t?.IsActive,
        state: (r.State__c as string | null) ?? null,
        city: (r.City__c as string | null) ?? null,
        county: (r.County__c as string | null) ?? null,
      };
    });
    const index = zipIndex(rows);
    zipCache = { index, at: now };
    return index;
  } catch {
    // Not cached: a blip must not mean an hour of routing without the map.
    return new Map();
  }
}

export async function processPendingLeads(sb: SupabaseClient, now = new Date(), query?: Query) {
  const out = { routed: 0, triaged: 0, ignored: 0, failed: 0 };
  const { data: pending } = await sb.from("sf_lead_inbound")
    .select("id, payload").eq("status", "pending").order("received_at").limit(50);
  if (!pending?.length) return out;

  // The zip map, once for the whole batch. Absent when the poll was called
  // without a Salesforce client, which is how every existing test calls it.
  const zips = query ? await loadZipMap(query) : new Map<string, ZipRow>();
  const territoryFor = (postalCode: string | null) => {
    const key = normalizeZip(postalCode);
    // No zip at all is NOT "not serviced" — it is simply no information, and
    // routing should fall back to the city rather than refuse the lead.
    if (!key) return null;
    if (!zips.size) return null;
    return territoryOf(zips.get(key) ?? null);
  };

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
        territoryFor,
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
        // The lead's own words and its address, kept for the conversation.
        // Routing reads the zip and then threw everything away; the reply
        // path needs it too.
        customerAddress: lead.address ?? null,
        customerZip: normalizeZip(lead.postalCode ?? null),
        inquiryScope: lead.inquiryScope ?? null,
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
