import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  hasRecentNotification,
  insertCommercialTaskOverdueNotification,
} from "@/lib/notifications/commercial-events";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * Daily cron job — fire bell + email for tasks whose due_at has passed
 * without completion. Dedupe window 24h per task: a task overdue for
 * a week generates ONE reminder per day, not seven.
 *
 * Targets: tasks with assigned_user_id (no point reminding "nobody")
 *          + completed_at IS NULL
 *          + deleted_at IS NULL
 *          + due_at < now()
 *          + parent opp still alive (deleted_at IS NULL on the opp + acct)
 *          + recipient profile active
 *
 * Order matters: dedup query first, then send. If the dedup fails
 * (DB hiccup) the helper fail-safes to "already sent" so we never
 * double-send on a transient error.
 */

type Result = {
  ok: boolean;
  found: number;
  sent: number;
  skipped: number;
  errors: string[];
};

export async function runOverdueTasksReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    // due_at is a DATE column (per migration 031). Comparing against a
    // TIMESTAMPTZ "now" promotes DATE → midnight-UTC, which flags a
    // task due TODAY as overdue starting 00:00 UTC (= 8pm prev-day ET).
    // Compare as date-only so "overdue" means strictly the deadline
    // date has already passed. A task due 2026-06-18 becomes overdue
    // starting on 2026-06-19, regardless of when the cron actually
    // fires today. Same fix applied to hot-deals-cooling.ts for
    // proposal_due_at.
    const todayDateStr = new Date().toISOString().slice(0, 10);

    // Pull all overdue, open, assigned tasks + nested opp + nested acct
    // in one query so the cron stays a single DB round-trip on the read
    // side. Inner-joins drop orphans (deleted opp / deleted account)
    // automatically without a follow-up filter pass.
    const { data, error } = await sb
      .from("commercial_opportunity_tasks")
      .select(
        `id, title, due_at, assigned_user_id,
         opportunity:commercial_opportunities!inner(
           id, title, client_name, location_short, deleted_at,
           account:commercial_accounts!inner(id, company_name, deleted_at)
         )`
      )
      .not("assigned_user_id", "is", null)
      .is("completed_at", null)
      .is("deleted_at", null)
      .lt("due_at", todayDateStr)
      .is("opportunity.deleted_at", null)
      .is("opportunity.account.deleted_at", null);
    if (error) {
      out.ok = false;
      out.errors.push(`task query failed: ${error.message}`);
      return out;
    }
    type OppInner = {
      id: string;
      title: string;
      client_name: string | null;
      location_short: string | null;
      deleted_at: string | null;
      account:
        | { id: string; company_name: string; deleted_at: string | null }
        | Array<{ id: string; company_name: string; deleted_at: string | null }>
        | null;
    };
    type Row = {
      id: string;
      title: string;
      due_at: string;
      assigned_user_id: string;
      opportunity: OppInner | Array<OppInner> | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    out.found = rows.length;

    for (const r of rows) {
      const opp = Array.isArray(r.opportunity) ? r.opportunity[0] ?? null : r.opportunity;
      if (!opp) {
        out.skipped += 1;
        continue;
      }
      try {
        // 23h, not 24h: cron fires daily on a 24h cadence, but a row
        // inserted at firing time N would still match dedup at firing
        // time N+24h (gte cutoff = exactly the insert timestamp). 23h
        // gives a 1-hour safety margin so each daily fire releases the
        // prior day's dedup. (Audit fix 2026-06-18.)
        const recent = await hasRecentNotification(
          "commercial_task_overdue",
          r.id,
          23
        );
        if (recent) {
          out.skipped += 1;
          continue;
        }
        // Phase B: compute the derived opp name from the joined account
        // so the notification body reads {account} - {client} - {location}
        // when the CEO structural fields are populated.
        const acct = Array.isArray(opp.account) ? opp.account[0] ?? null : opp.account;
        const accountName = acct?.company_name ?? null;
        const displayName = derivedOppName(opp, accountName);
        await insertCommercialTaskOverdueNotification({
          taskId: r.id,
          opportunityId: opp.id,
          taskTitle: r.title,
          dueAt: r.due_at,
          oppTitle: displayName,
          recipientUserId: r.assigned_user_id,
        });
        out.sent += 1;
      } catch (err) {
        out.errors.push(
          `task ${r.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
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
