import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { daysAgoEt } from "@/lib/date-et";
import { aiaBillingRollupBulk } from "@/lib/commercial/aia/db";
import { aiaDueAtFrom } from "@/lib/commercial/aia/constants";
import { DEFAULT_DUE_DAYS } from "@/lib/commercial/invoices/constants";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import {
  sendClientAiaDunningEmail,
  insertCommercialAiaDunningMarker,
} from "@/lib/notifications/commercial-events";

/**
 * Daily cron — the invoice dunning reminder, for the ledger that has none.
 *
 * A job billed through G702/G703 writes no `commercial_invoices` row, so
 * `invoice-dunning.ts` could never see it. A certified payment application
 * could sit ninety days past due and chase nobody — on the ledger carrying
 * Tomco's largest receivables.
 *
 * Deliberately a SEPARATE job rather than a branch inside invoice dunning:
 * the two share a schedule and a dedup contract, and nothing else. The
 * document is different, the email is different, and the "is it late" question
 * is answered by a derived date rather than a column.
 *
 * WHAT COUNTS AS OWED is not re-derived here. `aiaBillingRollupBulk` is the
 * same helper behind the AR-aging report, the receivables chase list, the deal
 * page and the dashboard, and `aiaDueAtFrom` is the same due-date ladder. A
 * reminder that disagreed with the report someone opens after receiving it
 * would be worse than no reminder — and retainage stays out of the figure for
 * the same reason it stays out of those: chasing a GC for money their contract
 * lets them hold until close-out is how you lose the relationship.
 *
 * Safety mirrors invoice dunning exactly: `last_dunning_at` on the application
 * is the dedup marker, claimed BEFORE the send, so the GC cannot be emailed
 * more than once per ~7 days even if a later write fails.
 */

type Result = { ok: boolean; found: number; sent: number; skipped: number; errors: string[] };

export const AIA_PAST_DUE_DAYS = 15; // same threshold as invoice dunning
export const AIA_REDUN_DAYS = 7; // re-send at most weekly
const DUNNING_MAX_PER_RUN = 100;

/**
 * Should this application be chased today?
 *
 * Pure, and exported, because every clause is a way to email a GC wrongly:
 * chasing retainage, chasing an amount with no date behind it, chasing twice
 * in a week, or chasing a bill that has since been deleted. The cron does the
 * fetching; this decides.
 */
export function shouldChaseAiaApplication(
  app: {
    /** Certified earned-less-retainage, less collected. Retainage is never in it. */
    dueNowCents: number;
    /** Derived from the issue date — null when nothing recorded when it went out. */
    dueAtIso: string | null;
    lastDunningAt: string | null;
    status: string;
    deletedAt: string | null;
  },
  daysPastDue: number,
  nowMs: number
): boolean {
  if (app.deletedAt) return false;
  // A draft application is not a bill. Only an issued one has been certified.
  if (app.status !== "submitted" && app.status !== "paid") return false;
  if (app.dueNowCents <= 0) return false;
  // No recorded issue date → we cannot say it is late, and an undated demand
  // is one the GC will dispute.
  if (!app.dueAtIso) return false;
  if (daysPastDue < AIA_PAST_DUE_DAYS) return false;
  if (!app.lastDunningAt) return true;
  const last = new Date(app.lastDunningAt).getTime();
  // An unparseable marker must not silence the chase forever.
  return Number.isNaN(last) || last < nowMs - AIA_REDUN_DAYS * 86_400_000;
}

/** Mask an email for the internal bell: "jane@gc.com" → "j***@gc.com". */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function runAiaDunningReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const now = Date.now();

    // includeArchived: archiving a deal is a tidy-up, not a write-off. The same
    // rule the AR-aging report and the receivables list settled on — money the
    // GC owes cannot stop being chased because someone tidied the pipeline.
    const opps = await listCommercialOpportunities({ includeArchived: true });
    if (opps.length === 0) return out;
    const rollups = await aiaBillingRollupBulk(opps.map((o) => o.id));
    if (rollups.size === 0) return out;

    type Candidate = {
      oppId: string;
      accountId: string;
      appId: string;
      appNumber: number;
      balanceCents: number;
      dueAtIso: string;
      daysPastDue: number;
    };
    const candidates: Candidate[] = [];
    const oppById = new Map(opps.map((o) => [o.id, o] as const));

    for (const [oppId, roll] of rollups) {
      if (roll.dueNowCents <= 0) continue;
      const dueAt = aiaDueAtFrom(
        roll.latestIssuedFrozenAt,
        roll.latestIssuedPeriodTo,
        DEFAULT_DUE_DAYS
      );
      // No recorded issue date → we cannot say it is late, and a reminder for
      // an amount we can't date is a reminder the GC will dispute.
      if (!dueAt) continue;
      // ET calendar days. The number goes into an email a client reads, and a
      // figure someone quotes back at you is the wrong place to be a day out.
      const daysPastDue = daysAgoEt(dueAt) ?? 0;
      if (daysPastDue < AIA_PAST_DUE_DAYS) continue;
      const opp = oppById.get(oppId);
      if (!opp) continue;
      candidates.push({
        oppId,
        accountId: opp.account_id,
        appId: roll.latestIssuedId,
        appNumber: roll.latestIssuedNumber,
        balanceCents: roll.dueNowCents,
        dueAtIso: dueAt,
        daysPastDue,
      });
    }
    if (candidates.length === 0) return out;

    // The weekly gate. Read after the money check rather than before: the set
    // of genuinely-overdue applications is far smaller than the set of
    // applications, so this is one small `in` rather than a table scan.
    const { data: markerRows, error: markerErr } = await sb
      .from("commercial_aia_applications")
      .select("id, last_dunning_at, deleted_at, status")
      .in("id", candidates.map((c) => c.appId));
    if (markerErr) {
      out.ok = false;
      out.errors.push(`aia dunning marker read failed: ${markerErr.message}`);
      return out;
    }
    const markerById = new Map(
      ((markerRows ?? []) as { id: string; last_dunning_at: string | null; deleted_at: string | null; status: string }[])
        .map((r) => [r.id, r] as const)
    );

    const due = candidates
      .filter((c) => {
        const m = markerById.get(c.appId);
        // The rollup already filtered to issued applications, but it is read
        // across two queries and this is the decision that emails a customer.
        if (!m) return false;
        return shouldChaseAiaApplication(
          {
            dueNowCents: c.balanceCents,
            dueAtIso: c.dueAtIso,
            lastDunningAt: m.last_dunning_at,
            status: m.status,
            deletedAt: m.deleted_at,
          },
          c.daysPastDue,
          now
        );
      })
      // Oldest first, so the daily cap converges on the worst debt.
      .sort((a, b) => b.daysPastDue - a.daysPastDue)
      .slice(0, DUNNING_MAX_PER_RUN);

    out.found = due.length;
    if (due.length === 0) return out;
    if (due.length >= DUNNING_MAX_PER_RUN) {
      console.warn(
        `[cron/aia-dunning] hit the ${DUNNING_MAX_PER_RUN}-row cap — remaining reminders fire on later days.`
      );
    }

    // The GC's billing email per account (primary contact wins).
    const accountIds = [...new Set(due.map((c) => c.accountId))];
    const { data: contactRows } = await sb
      .from("commercial_account_contacts")
      .select("account_id, is_primary, contact:commercial_contacts(email, deleted_at)")
      .in("account_id", accountIds);
    type CRow = {
      account_id: string;
      is_primary: boolean | null;
      contact:
        | { email: string | null; deleted_at: string | null }
        | Array<{ email: string | null; deleted_at: string | null }>
        | null;
    };
    const emailByAccount = new Map<string, string>();
    for (const c of (contactRows ?? []) as unknown as CRow[]) {
      const contact = Array.isArray(c.contact) ? c.contact[0] ?? null : c.contact;
      const email = contact && !contact.deleted_at ? contact.email?.trim() : null;
      if (!email) continue;
      if (c.is_primary || !emailByAccount.has(c.account_id)) {
        emailByAccount.set(c.account_id, email);
      }
    }

    // The internal primary lead per opp, for the bell.
    const { data: assignments } = await sb
      .from("commercial_opportunity_assignments")
      .select(
        "opportunity_id, user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(is_active, has_new_platform_access)"
      )
      .in("opportunity_id", [...new Set(due.map((c) => c.oppId))])
      .eq("is_primary", true)
      .is("removed_at", null);
    type Assn = {
      opportunity_id: string;
      user_id: string;
      user:
        | { is_active: boolean | null; has_new_platform_access: boolean | null }
        | Array<{ is_active: boolean | null; has_new_platform_access: boolean | null }>
        | null;
    };
    const leadByOpp = new Map<string, string>();
    for (const a of (assignments ?? []) as unknown as Assn[]) {
      const u = Array.isArray(a.user) ? a.user[0] ?? null : a.user;
      if (u?.is_active === false || u?.has_new_platform_access === false) continue;
      if (!leadByOpp.has(a.opportunity_id)) leadByOpp.set(a.opportunity_id, a.user_id);
    }

    // Account names, for the project label the GC will recognise.
    const { data: acctRows } = await sb
      .from("commercial_accounts")
      .select("id, company_name")
      .in("id", accountIds);
    const acctName = new Map(
      ((acctRows ?? []) as { id: string; company_name: string | null }[]).map((a) => [
        a.id,
        a.company_name ?? null,
      ])
    );

    for (const c of due) {
      try {
        const opp = oppById.get(c.oppId)!;
        const projectName = derivedOppName(opp, acctName.get(c.accountId) ?? null);
        const clientEmail = emailByAccount.get(c.accountId) ?? null;

        // CLAIM FIRST — mark before sending, and only send if the mark stuck.
        // The opposite ordering could email the GC, fail to mark, and email
        // again tomorrow. A failed mark costs one day's reminder, not a
        // duplicate.
        const { error: markErr } = await sb
          .from("commercial_aia_applications")
          .update({ last_dunning_at: new Date().toISOString() })
          .eq("id", c.appId);
        if (markErr) {
          out.errors.push(
            `aia app ${c.appId.slice(0, 8)}: dunning mark failed, skipping send: ${markErr.message}`
          );
          out.skipped += 1;
          continue;
        }

        let sentToClient = false;
        if (clientEmail) {
          const res = await sendClientAiaDunningEmail({
            to: clientEmail,
            applicationNumber: c.appNumber,
            projectName,
            balanceCents: c.balanceCents,
            dueDateIso: c.dueAtIso,
            daysPastDue: c.daysPastDue,
          });
          sentToClient = res.ok;
        }

        const lead = leadByOpp.get(c.oppId);
        if (lead) {
          await insertCommercialAiaDunningMarker({
            opportunityId: c.oppId,
            applicationId: c.appId,
            applicationNumber: c.appNumber,
            projectName,
            recipientUserId: lead,
            daysPastDue: c.daysPastDue,
            balanceCents: c.balanceCents,
            sentToClient,
            emailFailed: !!clientEmail && !sentToClient,
            clientEmailMasked: clientEmail ? maskEmail(clientEmail) : null,
          });
        }
        if (sentToClient) out.sent += 1;
        else out.skipped += 1;
      } catch (err) {
        out.errors.push(
          `aia app ${c.appId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}
