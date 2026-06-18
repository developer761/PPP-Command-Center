import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  hasRecentNotification,
  insertCommercialHotDealCoolingNotification,
} from "@/lib/notifications/commercial-events";
import {
  HOT_DEAL_ACTIVE_STATUSES,
  HOT_DEAL_BID_CENTS,
  HOT_DEAL_DECISION_DAYS,
} from "@/lib/commercial/opportunities/constants";

/**
 * Daily cron — fire bell + email when a HOT deal has gone cold (no
 * updated_at activity in 7+ days). Dedupe window 7 days per opp so a
 * truly-stuck deal generates one reminder per week, not seven.
 *
 * Hot deal = high-value AND closing soon AND in an active negotiation
 * status. Mirrors lib/commercial/opportunities/constants.ts so the
 * cron and the list-page hot chip filter stay in lockstep.
 *
 * Targets:
 *   - status in HOT_DEAL_ACTIVE_STATUSES
 *   - bid_value_high_cents >= HOT_DEAL_BID_CENTS  (≥ $50k)
 *   - proposal_due_at within HOT_DEAL_DECISION_DAYS (≤ 14 days out)
 *   - updated_at older than COOLING_DAYS (default 7 days)
 *   - parent account still alive
 *
 * Recipient: any ACTIVE primary assignment on the opp (sales lead
 * or AM). If none, the cron SKIPS the deal rather than falling back
 * to the opp's created_by_user_id — that fallback caused surprise
 * notifications to people (e.g. the original creator who handed off
 * the deal months ago) about an opp they no longer own. Better to
 * leave a no-primary deal silent + surface it in the "needs an owner"
 * view at the list-page level (out of scope for Stage 1).
 */

type Result = {
  ok: boolean;
  found: number;
  sent: number;
  skipped: number;
  errors: string[];
};

const COOLING_DAYS = 7;

export async function runHotDealsCoolingReminder(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const now = new Date();
    const coolingCutoff = new Date(now.getTime() - COOLING_DAYS * 24 * 60 * 60 * 1000);
    // proposal_due_at is a DATE column (per migration 028). Compare as
    // date-only so a 2026-06-18 proposal_due_at vs 2026-06-18 TIMESTAMPTZ
    // doesn't silently skip "due today" hot deals (the DATE promotes to
    // midnight UTC). Also: NO lower bound on proposal_due_at — past-due
    // hot deals are EXACTLY the cohort that needs the nudge, so we want
    // them included. Upper bound = today + 14 days = "decision is
    // imminent OR overdue."
    const decisionWindowEndDateStr = new Date(
      now.getTime() + HOT_DEAL_DECISION_DAYS * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);

    // Pull hot+cooling candidates in one query. Active status set, value
    // gate, decision window, staleness gate, and parent-account-alive
    // gate are all SQL-side so the post-query loop is small.
    const { data, error } = await sb
      .from("commercial_opportunities")
      .select(
        `id, title, updated_at, created_by_user_id,
         account:commercial_accounts!inner(id, deleted_at)`
      )
      .in("status", HOT_DEAL_ACTIVE_STATUSES as readonly string[])
      .gte("bid_value_high_cents", HOT_DEAL_BID_CENTS)
      .not("proposal_due_at", "is", null)
      .lte("proposal_due_at", decisionWindowEndDateStr)
      .lt("updated_at", coolingCutoff.toISOString())
      .is("deleted_at", null)
      .is("account.deleted_at", null);
    if (error) {
      out.ok = false;
      out.errors.push(`opp query failed: ${error.message}`);
      return out;
    }
    type Row = {
      id: string;
      title: string;
      updated_at: string;
      created_by_user_id: string | null;
      account:
        | { id: string; deleted_at: string | null }
        | Array<{ id: string; deleted_at: string | null }>
        | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    out.found = rows.length;
    if (rows.length === 0) return out;

    // Bulk recipient resolution — primaries on each opp. Join profiles
    // + filter is_active so a deactivated primary doesn't dead-letter
    // the alert. Falls through to the opp's created_by_user_id if there
    // is no live primary, with the same active check below.
    const oppIds = rows.map((r) => r.id);
    const { data: assignments } = await sb
      .from("commercial_opportunity_assignments")
      .select(
        "opportunity_id, user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(is_active)"
      )
      .in("opportunity_id", oppIds)
      .eq("is_primary", true)
      .is("removed_at", null);
    type Assn = {
      opportunity_id: string;
      user_id: string;
      user:
        | { is_active: boolean | null }
        | Array<{ is_active: boolean | null }>
        | null;
    };
    const primaryByOpp = new Map<string, string>();
    for (const a of (assignments ?? []) as unknown as Assn[]) {
      const u = Array.isArray(a.user) ? a.user[0] ?? null : a.user;
      if (u?.is_active === false) continue;
      // First-wins is fine — if there are multiple primaries we pick
      // any (the data shouldn't allow it via unique-partial-index, but
      // even if it did, "alert one" is better than "fan out to many").
      if (!primaryByOpp.has(a.opportunity_id)) {
        primaryByOpp.set(a.opportunity_id, a.user_id);
      }
    }

    for (const r of rows) {
      // Primary-only — created_by_user_id fallback was removed (audit
      // 2026-06-18) because it surprised the original creator with
      // alerts about deals they'd already handed off. A no-primary
      // hot deal silently skips here; surface that gap at the list-page
      // level instead.
      const recipient = primaryByOpp.get(r.id);
      if (!recipient) {
        out.skipped += 1;
        continue;
      }
      const daysSinceUpdate = Math.max(
        1,
        Math.floor((now.getTime() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24))
      );
      try {
        const recent = await hasRecentNotification(
          "commercial_hot_deal_cooling",
          r.id,
          COOLING_DAYS * 24
        );
        if (recent) {
          out.skipped += 1;
          continue;
        }
        await insertCommercialHotDealCoolingNotification({
          opportunityId: r.id,
          oppTitle: r.title,
          daysSinceUpdate,
          recipientUserId: recipient,
        });
        out.sent += 1;
      } catch (err) {
        out.errors.push(
          `opp ${r.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`
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
