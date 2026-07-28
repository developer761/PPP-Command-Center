import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  sendClientInvoiceDunningEmail,
  insertCommercialInvoiceDunningMarker,
} from "@/lib/notifications/commercial-events";

/**
 * Daily cron — email the GC billing contact a reminder once an invoice is 15+
 * days past due, at most once a week per invoice (np-billing-workflow §6).
 *
 * Safety: last_dunning_at on the invoice is the dedup marker, so the client
 * can't be emailed more than once per ~7 days regardless of internal state. If
 * the account has no contact email, we DON'T email — we set last_dunning_at
 * anyway (so we don't re-scan daily) and fire an internal "needs a contact"
 * bell to the opp's primary lead.
 */

type Result = { ok: boolean; found: number; sent: number; skipped: number; errors: string[] };

const PAST_DUE_DAYS = 15; // client reminder starts 15 days past due
const REDUN_DAYS = 7; // re-send at most weekly
// Per-run cap (re-audit 2026-07-28): each row is an email send (up to a few
// hundred ms) + 2-3 DB writes, under the route's 60s maxDuration. Cap well
// below a count that could time out; the last_dunning_at gate drains any
// backlog over subsequent days.
const DUNNING_MAX_PER_RUN = 100;

/** Mask an email for the internal bell: "jane@gc.com" → "j***@gc.com". */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

export async function runInvoiceDunningReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const now = Date.now();
    const pastDueCutoffIso = new Date(now - PAST_DUE_DAYS * 86_400_000).toISOString();
    const redunCutoffIso = new Date(now - REDUN_DAYS * 86_400_000).toISOString();

    const { data, error } = await sb
      .from("commercial_invoices")
      .select(
        `id, invoice_number, balance_cents, due_at, account_id, opportunity_id,
         account:commercial_accounts!inner(deleted_at)`
      )
      .not("status", "in", "(void,paid,draft)")
      .gt("balance_cents", 0)
      .not("due_at", "is", null)
      .lt("due_at", pastDueCutoffIso)
      .is("deleted_at", null)
      .is("account.deleted_at", null)
      .or(`last_dunning_at.is.null,last_dunning_at.lt.${redunCutoffIso}`)
      .order("due_at", { ascending: true })
      .limit(DUNNING_MAX_PER_RUN);
    if (error) {
      out.ok = false;
      out.errors.push(`dunning query failed: ${error.message}`);
      return out;
    }
    type Row = {
      id: string;
      invoice_number: string;
      balance_cents: number;
      due_at: string;
      account_id: string;
      opportunity_id: string;
    };
    const rows = (data ?? []) as unknown as Row[];
    out.found = rows.length;
    if (rows.length === 0) return out;
    if (rows.length >= DUNNING_MAX_PER_RUN) {
      console.warn(`[cron/invoice-dunning] hit the ${DUNNING_MAX_PER_RUN}-row cap — remaining reminders fire on later days.`);
    }

    // Batch-resolve the client billing email per account (prefer the primary
    // contact; else any contact with an email).
    const accountIds = Array.from(new Set(rows.map((r) => r.account_id)));
    const { data: contactRows } = await sb
      .from("commercial_account_contacts")
      .select("account_id, is_primary, contact:commercial_contacts(email, deleted_at)")
      .in("account_id", accountIds);
    type CRow = {
      account_id: string;
      is_primary: boolean | null;
      contact: { email: string | null; deleted_at: string | null } | Array<{ email: string | null; deleted_at: string | null }> | null;
    };
    const emailByAccount = new Map<string, string>();
    for (const c of (contactRows ?? []) as unknown as CRow[]) {
      const contact = Array.isArray(c.contact) ? c.contact[0] ?? null : c.contact;
      const email = contact && !contact.deleted_at ? contact.email?.trim() : null;
      if (!email) continue;
      // Primary wins; otherwise keep the first email seen.
      if (c.is_primary || !emailByAccount.has(c.account_id)) {
        emailByAccount.set(c.account_id, email);
      }
    }

    // Batch-resolve the internal primary lead per opp (for the internal marker).
    const oppIds = Array.from(new Set(rows.map((r) => r.opportunity_id)));
    const { data: assignments } = await sb
      .from("commercial_opportunity_assignments")
      .select(
        "opportunity_id, user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(is_active, has_new_platform_access)"
      )
      .in("opportunity_id", oppIds)
      .eq("is_primary", true)
      .is("removed_at", null);
    type Assn = {
      opportunity_id: string;
      user_id: string;
      user: { is_active: boolean | null; has_new_platform_access: boolean | null } | Array<{ is_active: boolean | null; has_new_platform_access: boolean | null }> | null;
    };
    const leadByOpp = new Map<string, string>();
    for (const a of (assignments ?? []) as unknown as Assn[]) {
      const u = Array.isArray(a.user) ? a.user[0] ?? null : a.user;
      if (u?.is_active === false || u?.has_new_platform_access === false) continue;
      if (!leadByOpp.has(a.opportunity_id)) leadByOpp.set(a.opportunity_id, a.user_id);
    }

    for (const r of rows) {
      try {
        const daysPastDue = Math.max(
          PAST_DUE_DAYS,
          Math.floor((now - new Date(r.due_at).getTime()) / 86_400_000)
        );
        const clientEmail = emailByAccount.get(r.account_id) ?? null;

        // CLAIM FIRST (re-audit 2026-07-28): mark the invoice as dunned BEFORE
        // sending, and only send if the mark succeeded. This guarantees a
        // client can't be re-emailed inside the 7-day window even if the marker
        // write fails — a failed mark skips the send this run (retried next
        // run) rather than risking a double-send. The opposite ordering could
        // email the client, then fail to mark, and re-email tomorrow.
        const { error: markErr } = await sb
          .from("commercial_invoices")
          .update({ last_dunning_at: new Date().toISOString() })
          .eq("id", r.id);
        if (markErr) {
          out.errors.push(`invoice ${r.id.slice(0, 8)}: dunning mark failed, skipping send: ${markErr.message}`);
          out.skipped += 1;
          continue;
        }

        let sentToClient = false;
        if (clientEmail) {
          const res = await sendClientInvoiceDunningEmail({
            to: clientEmail,
            invoiceNumber: r.invoice_number,
            balanceCents: r.balance_cents,
            dueDateIso: r.due_at,
            accountName: "",
            daysPastDue,
          });
          sentToClient = res.ok;
        }

        // Internal marker/bell to the primary lead (if any). Doubles as the
        // visible record of client outreach. emailFailed distinguishes a
        // genuine send failure (a contact exists) from "no contact on file".
        const lead = leadByOpp.get(r.opportunity_id);
        if (lead) {
          await insertCommercialInvoiceDunningMarker({
            invoiceId: r.id,
            invoiceNumber: r.invoice_number,
            recipientUserId: lead,
            daysPastDue,
            balanceCents: r.balance_cents,
            sentToClient,
            emailFailed: !!clientEmail && !sentToClient,
            clientEmailMasked: clientEmail ? maskEmail(clientEmail) : null,
          });
        }
        if (sentToClient) out.sent += 1;
        else out.skipped += 1;
      } catch (err) {
        out.errors.push(`invoice ${r.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}
