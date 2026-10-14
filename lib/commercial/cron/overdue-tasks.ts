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
    // fires today. Karan 2026-07-27 audit: this MUST be the ET date, not
    // the UTC date — otherwise the evening cron marks same-day tasks overdue.
    const todayDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

    // Pull all overdue, open, assigned tasks + nested opp + nested acct
    // in one query so the cron stays a single DB round-trip on the read
    // side. Inner-joins drop orphans (deleted opp / deleted account)
    // automatically without a follow-up filter pass.
    const { data, error } = await sb
      .from("commercial_opportunity_tasks")
      .select(
        `id, title, due_at, assigned_user_id,
         opportunity:commercial_opportunities!commercial_opportunity_tasks_opportunity_id_fkey!inner(
           id, title, client_name, property_street, deleted_at,
           account:commercial_accounts!inner(id, company_name, deleted_at)
         )`
      )
      .not("assigned_user_id", "is", null)
      .is("completed_at", null)
      .is("deleted_at", null)
      .lt("due_at", todayDateStr)
      .is("opportunity.deleted_at", null)
      // Don't nag about tasks on archived (buried) deals (2026-07-28 re-audit).
      .is("opportunity.archived_at", null)
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
      property_street: string | null;
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

    /*
     * 🔴 THE RECIPIENT HAS TO STILL BE HERE.
     *
     * The docblock above has promised "+ recipient profile active" since this
     * cron was written, and the query never checked it — opportunity and
     * account were inner-joined, the assignee was not. A task assigned to
     * somebody since deactivated produced a Slack post that notified NOBODY,
     * and counted it in `out.sent`, so the run reported success. That is the
     * "posts with no bell recipients" trap, still live here while the three
     * sibling crons (debrief-overdue, aia-dunning, custom-notification-rules)
     * all filter it.
     *
     * Same test they use: `is_active !== false && has_new_platform_access
     * !== false`. Not `=== true` — a null means "never set", which is how most
     * rows read, and treating that as inactive would silence the whole office.
     *
     * A FAILED lookup does not silence anybody either. If this query errors we
     * cannot tell who is active, and dropping every reminder would be a worse
     * answer than sending them; so the set is left permissive and the failure
     * is recorded, matching how the email-preference lookup handles the same
     * dilemma.
     */
    const assigneeIds = [...new Set(rows.map((r) => r.assigned_user_id))];
    let inactiveAssignees = new Set<string>();
    if (assigneeIds.length > 0) {
      const { data: profs, error: profErr } = await sb
        .from("profiles")
        .select("user_id, is_active, has_new_platform_access")
        .in("user_id", assigneeIds);
      if (profErr) {
        out.errors.push(
          `profile lookup failed: ${profErr.message} — reminders NOT suppressed, cannot tell who is active`,
        );
      } else {
        const seen = new Set<string>();
        inactiveAssignees = new Set(
          ((profs ?? []) as Array<{
            user_id: string;
            is_active: boolean | null;
            has_new_platform_access: boolean | null;
          }>)
            .filter((p) => {
              seen.add(p.user_id);
              return p.is_active === false || p.has_new_platform_access === false;
            })
            .map((p) => p.user_id),
        );
        // An assignee with NO profile row at all cannot receive a bell either.
        for (const id of assigneeIds) if (!seen.has(id)) inactiveAssignees.add(id);
      }
    }

    for (const r of rows) {
      if (inactiveAssignees.has(r.assigned_user_id)) {
        // Skipped, not sent: no bell is possible, so no Slack post either.
        out.skipped += 1;
        continue;
      }
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
