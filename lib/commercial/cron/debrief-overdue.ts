import "server-only";
import { daysFromTodayEt } from "@/lib/date-et";

import { commercialDb } from "@/lib/commercial/db";
import {
  hasRecentNotification,
  insertCommercialDebriefOverdueNotification,
} from "@/lib/notifications/commercial-events";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * Daily cron — nudge the owner when a won/lost opportunity is still
 * un-debriefed 7+ days after the decision (win-loss-flow spec §5). The banner +
 * dashboard count already surface it; this is the active reminder.
 *
 * Recipient: the opp's active primary lead (the person who owns the debrief).
 * No primary → skip (mirrors hot-deals-cooling). Dedup: 7-day window per opp so
 * a lingering un-debriefed deal alerts once a week, not daily.
 */

type Result = { ok: boolean; found: number; sent: number; skipped: number; errors: string[] };

const DEBRIEF_GRACE_DAYS = 7;

export async function runDebriefOverdueReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const now = Date.now();
    const cutoffIso = new Date(now - DEBRIEF_GRACE_DAYS * 86_400_000).toISOString();

    const { data, error } = await sb
      .from("commercial_opportunities")
      .select(
        `id, account_id, title, client_name, property_street, sub_status, decided_at,
         account:commercial_accounts!inner(company_name, deleted_at)`
      )
      .eq("status", "pre_sale_closed")
      .is("win_loss_debriefed_at", null)
      .not("decided_at", "is", null)
      .lte("decided_at", cutoffIso)
      .is("deleted_at", null)
      .is("archived_at", null)
      .is("account.deleted_at", null)
      .order("decided_at", { ascending: true })
      .limit(500);
    if (error) {
      out.ok = false;
      out.errors.push(`debrief-overdue query failed: ${error.message}`);
      return out;
    }
    type Row = {
      id: string;
      account_id: string;
      title: string | null;
      client_name: string | null;
      property_street: string | null;
      sub_status: string | null;
      decided_at: string;
      account:
        | { company_name: string; deleted_at: string | null }
        | Array<{ company_name: string; deleted_at: string | null }>
        | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    out.found = rows.length;
    if (rows.length === 0) return out;
    if (rows.length >= 500) {
      console.warn("[cron/debrief-overdue] hit the 500-row cap — some reminders deferred.");
    }

    // Resolve the active primary lead per opp.
    const oppIds = rows.map((r) => r.id);
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
      user:
        | { is_active: boolean | null; has_new_platform_access: boolean | null }
        | Array<{ is_active: boolean | null; has_new_platform_access: boolean | null }>
        | null;
    };
    const primaryByOpp = new Map<string, string>();
    for (const a of (assignments ?? []) as unknown as Assn[]) {
      const u = Array.isArray(a.user) ? a.user[0] ?? null : a.user;
      if (u?.is_active === false || u?.has_new_platform_access === false) continue;
      if (!primaryByOpp.has(a.opportunity_id)) primaryByOpp.set(a.opportunity_id, a.user_id);
    }

    for (const r of rows) {
      const recipient = primaryByOpp.get(r.id);
      if (!recipient) {
        out.skipped += 1;
        continue;
      }
      try {
        const recent = await hasRecentNotification(
          "commercial_debrief_overdue",
          r.id,
          (DEBRIEF_GRACE_DAYS - 1) * 24
        );
        if (recent) {
          out.skipped += 1;
          continue;
        }
        const acct = Array.isArray(r.account) ? r.account[0] ?? null : r.account;
        const displayName = derivedOppName({ ...r, title: r.title ?? "" }, acct?.company_name ?? null);
        const outcome = r.sub_status === "won" ? "won" : "lost";
        // `decided_at` is a bare DATE. `new Date("2026-08-12")` is UTC
        // midnight — four or five hours BEHIND the Eastern day it names — so
        // subtracting it from `now` inflated the count by a day for most of
        // the working day. This number goes straight into the notification a
        // rep reads ("won 8 days ago"), so it was wrong in writing.
        const daysSinceDecision = Math.max(1, -daysFromTodayEt(String(r.decided_at).slice(0, 10)));
        await insertCommercialDebriefOverdueNotification({
          opportunityId: r.id,
          accountId: r.account_id,
          oppTitle: displayName,
          outcome,
          daysSinceDecision,
          recipientUserId: recipient,
        });
        out.sent += 1;
      } catch (err) {
        out.errors.push(`opp ${r.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}
