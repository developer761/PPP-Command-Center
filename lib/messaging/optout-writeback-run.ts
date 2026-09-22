/**
 * Pushing opt-outs back into Salesforce, on the tick.
 *
 * optout-writeback.ts has existed, pure and tested, with NO CALLER. So the
 * path it was written to replace is still the live one: Hatch fires a webhook,
 * Apex tries to match, and on a miss somebody transcribes the record by hand.
 * Kate's numbers for that path — 213 unmatched, 55 of them with the record
 * sitting right there — are what this removes.
 *
 * ── THIS WRITES TO SALESFORCE ───────────────────────────────────────────
 *
 * Everything else in lib/messaging reads Salesforce and nothing more, and the
 * lead poll says so at the top of the file. This is the exception, so it is
 * the one thing here behind its own switch:
 *
 *   SF_OPTOUT_WRITEBACK=true
 *
 * Off by default, which is exactly today's behaviour — the suppression list
 * still holds, nobody is texted, and Salesforce simply does not learn about it.
 * Turning it on modifies records in PPP's system of record, so it is a
 * decision somebody makes on purpose rather than a side effect of a deploy.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────
 *
 * SMS_Opt_In__c = 'Opt-Out' for an SMS opt-out, Email_Opt_In__c and
 * HasOptedOutOfEmail for an email one. Every field and the exact picklist
 * value were checked against the live org on 2026-09-22 and exist, updateable,
 * on both Lead and Contact. It never writes anything else, and never creates a
 * record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeOptOutToSalesforce, type SfMatch, type OptOutTarget } from "./optout-writeback";
import { toE164, type E164 } from "./phone";

/** How many opt-outs one sweep handles. Small: each is a Salesforce round trip. */
export const WRITEBACK_BATCH = 25;
/** After this many attempts a row stops being retried and waits for a person. */
export const MAX_TRIES = 3;

export type WritebackSummary = {
  ran: boolean;
  considered: number;
  written: number;
  pending: number;
  failed: number;
  why?: string;
};

export function writebackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SF_OPTOUT_WRITEBACK === "true";
}

/** Salesforce matches the last ten digits, because stored formats vary wildly. */
export function lastTen(phone: string | null): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Escape a value going into a SOQL string literal. */
export function soqlString(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type Query = (soql: string) => Promise<{ records: Record<string, unknown>[] }>;
type Update = (sObject: "Lead" | "Contact", id: string, fields: Record<string, unknown>) => Promise<void>;

/**
 * Find every Lead and Contact matching either identifier.
 *
 * BOTH objects and BOTH identifiers, because 92 of Kate's 213 arrived over
 * email and a phone-only match would have missed all of them. A person can
 * legitimately be several records; all of them get marked.
 */
export function buildFindRecords(query: Query) {
  return async (target: OptOutTarget): Promise<SfMatch[]> => {
    const ten = lastTen(target.phone);
    const email = target.email?.trim().toLowerCase() || null;
    if (!ten && !email) return [];

    const out: SfMatch[] = [];
    for (const sObject of ["Lead", "Contact"] as const) {
      const clauses: string[] = [];
      // LIKE '%1234567890' is the same match Kate's Apex makes, and the only
      // one that works across "(516) 344-8418", "516-344-8418" and "+1516…".
      if (ten) clauses.push(`Phone LIKE '%${soqlString(ten)}' OR MobilePhone LIKE '%${soqlString(ten)}'`);
      if (email) clauses.push(`Email = '${soqlString(email)}'`);

      // Converted leads are history; marking one changes nothing a customer
      // sees, and the Contact it became is matched separately.
      const extra = sObject === "Lead" ? " AND IsConverted = false" : "";
      const soql = `SELECT Id, Phone, MobilePhone, Email FROM ${sObject} WHERE (${clauses.join(" OR ")})${extra} LIMIT 50`;

      const res = await query(soql);
      for (const r of res.records ?? []) {
        const matchedOn: "phone" | "email" =
          email && String(r.Email ?? "").toLowerCase() === email ? "email" : "phone";
        out.push({ sObject, id: String(r.Id), matchedOn });
      }
    }
    return out;
  };
}

export function buildSetOptOut(update: Update) {
  return async (match: SfMatch, fields: Record<string, unknown>): Promise<void> => {
    await update(match.sObject, match.id, fields);
  };
}

/**
 * One sweep: take opt-outs Salesforce has not been told about, and tell it.
 *
 * Reads rows that are not yet 'written' and have tries left. A row that
 * matched nothing stays 'pending_no_record' and is retried later, because the
 * commonest reason for no match is that the person opted out before any
 * Salesforce record existed — and one may appear tomorrow.
 */
export async function runOptOutWriteback(
  sb: SupabaseClient,
  query: Query,
  update: Update,
  env: NodeJS.ProcessEnv = process.env
): Promise<WritebackSummary> {
  const empty: WritebackSummary = { ran: false, considered: 0, written: 0, pending: 0, failed: 0 };
  if (!writebackEnabled(env)) {
    return { ...empty, why: "SF_OPTOUT_WRITEBACK is not set, so Salesforce is not being written to" };
  }

  const { data: rows, error } = await sb
    .from("sms_opt_outs")
    .select("id, phone_e164, email, channel, sf_writeback_status, sf_writeback_tries")
    .is("opted_in_at", null)
    .or("sf_writeback_status.is.null,sf_writeback_status.neq.written")
    .lt("sf_writeback_tries", MAX_TRIES)
    .order("opted_out_at", { ascending: true })
    .limit(WRITEBACK_BATCH);
  // Tolerates the migration not being applied: without the columns this errors,
  // and doing nothing is exactly what happened before it existed.
  if (error) return { ...empty, ran: false, why: `cannot read writeback state: ${error.message}` };

  const summary: WritebackSummary = { ...empty, ran: true, considered: (rows ?? []).length };
  const findRecords = buildFindRecords(query);
  const setOptOut = buildSetOptOut(update);

  for (const r of rows ?? []) {
    const target: OptOutTarget = {
      phone: toE164((r.phone_e164 as string | null) ?? null) as E164 | null,
      email: (r.email as string | null) ?? null,
    };
    // The row's own channel decides which fields are set. Marking somebody
    // opted out of email because they texted STOP is a different decision and
    // not one this makes.
    const channel = (r.channel as string) === "email" ? "email" : "sms";

    const result = await writeOptOutToSalesforce(target, channel, { findRecords, setOptOut });

    if (result.status === "written") summary.written++;
    else if (result.status === "pending_no_record") summary.pending++;
    else summary.failed++;

    await sb.from("sms_opt_outs").update({
      sf_writeback_status: result.status,
      sf_writeback_at: new Date().toISOString(),
      sf_writeback_detail: result.detail.slice(0, 500),
      // Only a real failure burns a try. "No record yet" is expected and must
      // stay retryable — that is the 98-of-213 case.
      sf_writeback_tries: ((r.sf_writeback_tries as number) ?? 0) + (result.status === "failed" ? 1 : 0),
      updated_at: new Date().toISOString(),
    }).eq("id", r.id as string);
  }

  return summary;
}
