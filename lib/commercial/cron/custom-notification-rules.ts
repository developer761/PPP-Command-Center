import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { insertCustomRuleNotification } from "@/lib/notifications/commercial-events";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { OPEN_OPP_STATUSES } from "@/lib/commercial/opportunities/constants";
import type { NotificationRule } from "@/lib/commercial/notification-rules/db";

/**
 * Daily cron job — evaluate every ENABLED custom notification rule and fire the
 * owner a `commercial_custom_rule` notification for each newly-matching entity.
 *
 * Runs inside the existing once-a-day commercial cron (Vercel Hobby caps crons
 * at 1/day — no new cron slot).
 *
 * Dedup: a fire is recorded per (rule_id, entity_id). We only notify entities
 * not already fired, so a rule alerts once per entity, not every day. For
 * follow-up-due the entity key includes the follow-up date, so rescheduling to
 * a NEW date re-fires. Cap: MAX_FIRES_PER_RULE per run so one rule matching
 * hundreds of rows can't flood a mailbox — the remainder fire on later days.
 */

type Result = { ok: boolean; found: number; sent: number; skipped: number; errors: string[] };

const MAX_FIRES_PER_RULE = 25;
// Lookback window for threshold-less event triggers (deal_won/lost, invoice_paid).
const RECENT_EVENT_WINDOW_DAYS = 2;

type Match = { entityId: string; title: string; body: string; link: string };

export async function runCustomNotificationRules(): Promise<Result> {
  const out: Result = { ok: true, found: 0, sent: 0, skipped: 0, errors: [] };
  try {
    const sb = commercialDb();
    const nowMs = Date.now();

    const { data: ruleData, error: ruleErr } = await sb
      .from("commercial_notification_rules")
      .select("*")
      .eq("enabled", true);
    if (ruleErr) {
      out.ok = false;
      out.errors.push(`rules query failed: ${ruleErr.message}`);
      return out;
    }
    const rules = (ruleData ?? []) as NotificationRule[];
    if (rules.length === 0) return out;

    // Owners still active + with commercial access — skip a rule whose owner
    // was deactivated / lost access (they can't act on the alert).
    const ownerIds = Array.from(new Set(rules.map((r) => r.owner_user_id)));
    const { data: owners } = await sb
      .from("profiles")
      .select("user_id, is_active, has_new_platform_access")
      .in("user_id", ownerIds);
    const activeOwners = new Set(
      ((owners ?? []) as Array<{ user_id: string; is_active: boolean | null; has_new_platform_access: boolean | null }>)
        .filter((o) => o.is_active !== false && o.has_new_platform_access !== false)
        .map((o) => o.user_id)
    );

    for (const rule of rules) {
      if (!activeOwners.has(rule.owner_user_id)) {
        out.skipped += 1;
        continue;
      }
      try {
        const matches = await evaluateRule(sb, rule, nowMs);
        out.found += matches.length;
        if (matches.length === 0) {
          await touchEvaluated(sb, rule.id);
          continue;
        }

        // Which of these entities have we already fired for this rule?
        const entityIds = matches.map((m) => m.entityId);
        const { data: fired } = await sb
          .from("commercial_notification_rule_fires")
          .select("entity_id")
          .eq("rule_id", rule.id)
          .in("entity_id", entityIds);
        const firedSet = new Set(((fired ?? []) as Array<{ entity_id: string }>).map((f) => f.entity_id));

        const fresh = matches.filter((m) => !firedSet.has(m.entityId));
        if (fresh.length > MAX_FIRES_PER_RULE) {
          console.warn(
            `[cron/custom-rules] rule ${rule.id.slice(0, 8)} matched ${fresh.length} new entities — capping at ${MAX_FIRES_PER_RULE}; the rest fire on later days.`
          );
        }
        const toFire = fresh.slice(0, MAX_FIRES_PER_RULE);

        for (const m of toFire) {
          // CLAIM FIRST — insert the fire row before dispatching. If a
          // concurrent run (Vercel retry after a timeout, or a manual hit
          // overlapping the schedule) already claimed this entity, the unique
          // (rule_id, entity_id) PK rejects our insert and we skip the send —
          // so the owner is never double-notified. Recording the claim even
          // when delivery is later skipped (inactive owner) also prevents a
          // daily retry on a dead recipient.
          const { error: claimErr } = await sb
            .from("commercial_notification_rule_fires")
            .insert({ rule_id: rule.id, entity_id: m.entityId });
          if (claimErr) {
            if (!/duplicate key/i.test(claimErr.message)) {
              out.errors.push(`rule ${rule.id.slice(0, 8)} claim: ${claimErr.message}`);
            }
            continue; // already fired (this run or a concurrent one)
          }
          const res = await insertCustomRuleNotification({
            recipientUserId: rule.owner_user_id,
            sourceId: m.entityId.split(":")[0], // strip any composite suffix
            title: m.title,
            body: m.body,
            link: m.link,
            channel: rule.channel,
          });
          if (res.ok) {
            // ok=true: delivered (written) OR a deliberate skip (inactive owner /
            // dedup) — either way the claim rightly stays so we don't re-fire.
            if (res.written) out.sent += 1;
            else out.skipped += 1;
          } else {
            // ok=false: a TRANSIENT delivery failure. Roll back the claim so the
            // next run retries — claim-first would otherwise drop this alert
            // permanently (audit #27).
            await sb
              .from("commercial_notification_rule_fires")
              .delete()
              .eq("rule_id", rule.id)
              .eq("entity_id", m.entityId);
            out.skipped += 1;
            out.errors.push(`rule ${rule.id.slice(0, 8)} deliver: transient failure — claim rolled back for retry`);
          }
        }
        await touchEvaluated(sb, rule.id);
      } catch (err) {
        out.errors.push(`rule ${rule.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  } catch (err) {
    out.ok = false;
    out.errors.push(err instanceof Error ? err.message : String(err));
    return out;
  }
}

async function touchEvaluated(sb: ReturnType<typeof commercialDb>, ruleId: string): Promise<void> {
  await sb
    .from("commercial_notification_rules")
    .update({ last_evaluated_at: new Date().toISOString() })
    .eq("id", ruleId);
}

async function evaluateRule(
  sb: ReturnType<typeof commercialDb>,
  rule: NotificationRule,
  nowMs: number
): Promise<Match[]> {
  const cutoffIso = new Date(nowMs - rule.threshold_days * 86_400_000).toISOString();
  // Date-only "today" in America/New_York for date-column comparisons.
  const todayEt = new Date(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/New_York" }))
    .toISOString()
    .slice(0, 10);
  // Event triggers (deal_won / deal_lost / invoice_paid) have no threshold — we
  // look back a fixed 2-day window so a skipped cron run can't miss the event.
  // The (rule, entity) fire-log still guarantees each event fires exactly once.
  const recentCutoffIso = new Date(nowMs - RECENT_EVENT_WINDOW_DAYS * 86_400_000).toISOString();

  // Soft-deleting an ACCOUNT doesn't cascade to its invoices/opps (they stay
  // live), so a custom rule would keep firing about a buried customer. Drop any
  // match whose parent account is soft-deleted (audit #18).
  const { data: delAccts } = await sb
    .from("commercial_accounts")
    .select("id")
    .not("deleted_at", "is", null);
  const deletedAccountIds = new Set(((delAccts ?? []) as Array<{ id: string }>).map((a) => a.id));

  switch (rule.trigger) {
    case "invoice_overdue": {
      // Exclude soft-deleted + drafts (a draft was never sent, so it isn't
      // "overdue"); oldest-due first so the daily cap converges deterministically.
      const { data, error } = await sb
        .from("commercial_invoices")
        .select("id, account_id, invoice_number, due_at, balance_cents, status")
        .not("status", "in", "(void,paid,draft)")
        .gt("balance_cents", 0)
        .not("due_at", "is", null)
        .lt("due_at", cutoffIso)
        .is("deleted_at", null)
        .order("due_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "invoice_overdue");
      return ((data ?? []) as Array<{ id: string; account_id: string; invoice_number: string; due_at: string; balance_cents: number }>)
        .filter((i) => !deletedAccountIds.has(i.account_id))
        .map((i) => ({
        entityId: i.id,
        title: `Invoice ${i.invoice_number} is ${rule.threshold_days}+ days past due`,
        body: `Balance ${formatCents(i.balance_cents)} — due ${fmtDate(i.due_at)}.`,
        link: `/commercial/invoices/${i.id}`,
      }));
    }
    case "proposal_idle": {
      const { data, error } = await sb
        .from("commercial_proposals")
        .select("id, revision_number, sent_at, opportunity:commercial_opportunities!commercial_proposals_opportunity_id_fkey!inner(id, account_id, title, title_override, client_name, property_street, deleted_at, archived_at)")
        .eq("status", "sent")
        .not("sent_at", "is", null)
        .lt("sent_at", cutoffIso)
        .is("deleted_at", null)
        .order("sent_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "proposal_idle");
      type Row = {
        id: string; revision_number: number; sent_at: string;
        opportunity: { id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; deleted_at: string | null; archived_at: string | null } | Array<{ id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; deleted_at: string | null; archived_at: string | null }> | null;
      };
      return ((data ?? []) as unknown as Row[])
        .map((p) => {
          const opp = Array.isArray(p.opportunity) ? p.opportunity[0] ?? null : p.opportunity;
          // Skip deleted OR archived parent deals (archived = deliberately buried),
          // and deals under a soft-deleted account (audit #18).
          if (!opp || opp.deleted_at || opp.archived_at || deletedAccountIds.has(opp.account_id)) return null;
          const name = derivedOppName({ ...opp, title: opp.title ?? "" }, null);
          return {
            entityId: p.id,
            title: `Proposal R${p.revision_number} — no response in ${rule.threshold_days}+ days`,
            body: `${name} · sent ${fmtDate(p.sent_at)}.`,
            link: `/commercial/accounts/${opp.account_id}/deals/${opp.id}/proposal/${p.id}`,
          } as Match;
        })
        .filter((m): m is Match => m !== null);
    }
    case "followup_due": {
      const { data, error } = await sb
        .from("commercial_opportunities")
        .select("id, account_id, title, title_override, client_name, property_street, follow_up_at")
        .not("follow_up_at", "is", null)
        .lte("follow_up_at", todayEt)
        .is("deleted_at", null)
        .is("archived_at", null)
        .in("status", OPEN_OPP_STATUSES as readonly string[])
        .order("follow_up_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "followup_due");
      return ((data ?? []) as Array<{ id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; follow_up_at: string }>)
        .filter((o) => !deletedAccountIds.has(o.account_id))
        .map((o) => ({
        // Composite key: rescheduling to a new date re-fires.
        entityId: `${o.id}:${o.follow_up_at}`,
        title: `Follow-up due: ${derivedOppName({ ...o, title: o.title ?? "" }, null)}`,
        body: `Scheduled follow-up date has arrived (${fmtDate(o.follow_up_at)}).`,
        link: `/commercial/opportunities/${o.id}`,
      }));
    }
    case "opp_no_activity": {
      const { data, error } = await sb
        .from("commercial_opportunities")
        .select("id, account_id, title, title_override, client_name, property_street, updated_at")
        .in("status", OPEN_OPP_STATUSES as readonly string[])
        .lt("updated_at", cutoffIso)
        .is("deleted_at", null)
        .is("archived_at", null)
        .order("updated_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "opp_no_activity");
      return ((data ?? []) as Array<{ id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; updated_at: string }>)
        .filter((o) => !deletedAccountIds.has(o.account_id))
        .map((o) => ({
        // Composite key with the idle-since date so a deal that goes idle, is
        // worked (updated_at bumps), then idle again RE-fires — a bare opp id
        // fired once for all time (fire rows are permanent).
        entityId: `${o.id}:${o.updated_at.slice(0, 10)}`,
        title: `No activity in ${rule.threshold_days}+ days: ${derivedOppName({ ...o, title: o.title ?? "" }, null)}`,
        body: `Last touched ${fmtDate(o.updated_at)}.`,
        link: `/commercial/opportunities/${o.id}`,
      }));
    }
    case "invoice_due_soon": {
      // Coming due within N days: due date between today (ET) and now+N days,
      // still open (unpaid, not void/draft/deleted). Excludes already-overdue
      // (that's the invoice_overdue trigger).
      // Compare on the ET CALENDAR DAY, not the cron's wall-clock instant.
      // due_at is stored at noon ET; the old bound (now + N days, a ~12:00 UTC
      // timestamp) fell BEFORE that noon-ET due time, so an invoice due exactly N
      // days out was excluded until the next run — every alert a day late — and
      // threshold 0 ("due today", which the rule form allows) could never fire at
      // all (audit N6). Exclusive upper bound at midnight of (today + N + 1)
      // includes the whole target day.
      const [ty, tm, td] = todayEt.split("-").map(Number);
      const dueByExclusive = new Date(Date.UTC(ty, tm - 1, td + rule.threshold_days + 1))
        .toISOString()
        .slice(0, 10);
      const { data, error } = await sb
        .from("commercial_invoices")
        .select("id, account_id, invoice_number, due_at, balance_cents, status")
        .not("status", "in", "(void,paid,draft)")
        .gt("balance_cents", 0)
        .not("due_at", "is", null)
        .gte("due_at", todayEt)
        .lt("due_at", dueByExclusive)
        .is("deleted_at", null)
        .order("due_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "invoice_due_soon");
      return ((data ?? []) as Array<{ id: string; account_id: string; invoice_number: string; due_at: string; balance_cents: number }>)
        .filter((i) => !deletedAccountIds.has(i.account_id))
        .map((i) => ({
        entityId: i.id,
        title: `Invoice ${i.invoice_number} due within ${rule.threshold_days} days`,
        body: `Balance ${formatCents(i.balance_cents)} — due ${fmtDate(i.due_at)}.`,
        link: `/commercial/invoices/${i.id}`,
      }));
    }
    case "invoice_paid": {
      // Recently marked paid in full. paid_at is stamped on full payment.
      const { data, error } = await sb
        .from("commercial_invoices")
        .select("id, account_id, invoice_number, total_cents, paid_at, status")
        .eq("status", "paid")
        .not("paid_at", "is", null)
        .gte("paid_at", recentCutoffIso)
        .is("deleted_at", null)
        .order("paid_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "invoice_paid");
      return ((data ?? []) as Array<{ id: string; account_id: string; invoice_number: string; total_cents: number | null; paid_at: string }>)
        .filter((i) => !deletedAccountIds.has(i.account_id))
        .map((i) => ({
        entityId: i.id,
        title: `Invoice ${i.invoice_number} paid in full`,
        body: `${i.total_cents != null ? formatCents(i.total_cents) + " — " : ""}paid ${fmtDate(i.paid_at)}.`,
        link: `/commercial/invoices/${i.id}`,
      }));
    }
    case "deal_won": {
      const { data, error } = await sb
        .from("commercial_opportunities")
        .select("id, account_id, title, title_override, client_name, property_street, decided_at")
        .eq("status", "pre_sale_closed")
        .eq("sub_status", "won")
        .not("decided_at", "is", null)
        .gte("decided_at", recentCutoffIso)
        .is("deleted_at", null)
        .is("archived_at", null)
        .order("decided_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "deal_won");
      return ((data ?? []) as Array<{ id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; decided_at: string }>)
        .filter((o) => !deletedAccountIds.has(o.account_id))
        .map((o) => ({
        entityId: o.id,
        title: `Deal won: ${derivedOppName({ ...o, title: o.title ?? "" }, null)}`,
        body: `Marked won ${fmtDate(o.decided_at)}.`,
        link: `/commercial/opportunities/${o.id}`,
      }));
    }
    case "deal_lost": {
      const { data, error } = await sb
        .from("commercial_opportunities")
        .select("id, account_id, title, title_override, client_name, property_street, decided_at")
        .eq("status", "pre_sale_closed")
        .eq("sub_status", "lost")
        .not("decided_at", "is", null)
        .gte("decided_at", recentCutoffIso)
        .is("deleted_at", null)
        .is("archived_at", null)
        .order("decided_at", { ascending: true })
        .limit(500);
      warnIfCapped(data, error, "deal_lost");
      return ((data ?? []) as Array<{ id: string; account_id: string; title: string | null; title_override: string | null; client_name: string | null; property_street: string | null; decided_at: string }>)
        .filter((o) => !deletedAccountIds.has(o.account_id))
        .map((o) => ({
        entityId: o.id,
        title: `Deal lost: ${derivedOppName({ ...o, title: o.title ?? "" }, null)}`,
        body: `Marked lost ${fmtDate(o.decided_at)}.`,
        link: `/commercial/opportunities/${o.id}`,
      }));
    }
    default:
      return [];
  }
}

const QUERY_LIMIT = 500;
function warnIfCapped(data: unknown[] | null, error: { message: string } | null, trigger: string): void {
  // A failed query returns data=null. Without surfacing it, evaluateRule treated
  // the empty result as "0 matches" and the caller touchEvaluated() the rule as a
  // successful, quiet run — silently skipping real overdue/idle items on a
  // transient DB error (audit medium). Throw so the caller's per-rule catch
  // records the failure and the rule retries next run instead of marking done.
  if (error) {
    throw new Error(`[cron/custom-rules] ${trigger} query failed: ${error.message}`);
  }
  if (data && data.length >= QUERY_LIMIT) {
    console.warn(
      `[cron/custom-rules] ${trigger} query hit the ${QUERY_LIMIT}-row limit — some matches may be deferred. Consider narrowing or paginating.`
    );
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  // Bare DATE columns ("2026-08-04") parse as UTC midnight and render a day
  // early in ET — anchor at noon UTC so the ET calendar day is preserved.
  const norm = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso;
  const d = new Date(norm);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}
