import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Putting a sold job, or a change order approved after it, in line for
 * Salesforce.
 *
 * Deliberately the only thing the Commercial platform calls. It is one local
 * insert with no Salesforce in it at all, so a slow or unreachable org cannot
 * reach back and fail somebody marking a job won.
 *
 * Everything that follows — deciding, writing, reading back — happens in
 * /api/cron/tomco-writeback, within the minute.
 */

const TABLE = "commercial_tomco_writeback_queue";

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export type QueueKind = "sale" | "change_order";

/**
 * Queue something for the write-back. Never throws.
 *
 * NEVER THROWS IS THE POINT, not politeness. This is called from inside
 * `changeOpportunityStatus`, where the neighbouring project and work-order
 * ensures are both wrapped for the same reason: a job must not fail to be
 * marked sold because a bookkeeping row could not be written. A failure here
 * costs a delay — the nightly sweep finds the deal and queues it again.
 */
export async function queueForWriteBack(input: {
  kind: QueueKind;
  opportunityId: string;
  changeOrderId?: string | null;
  actingUserId?: string | null;
}): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  try {
    const sb = adminClient();
    const { error } = await sb.from(TABLE).insert({
      kind: input.kind,
      opportunity_id: input.opportunityId,
      change_order_id: input.changeOrderId ?? null,
      queued_by_user_id: input.actingUserId ?? null,
    });
    if (error) {
      /*
       * 23505 is the partial unique index doing its job: this thing is already
       * waiting. The status hook re-fires on every status change by design —
       * the narrow "only on the transition" gate lost Thermo Fisher once — so
       * a deal edited five times would otherwise queue five writes of one sale.
       * Already-queued is success.
       */
      if (error.code === "23505") return { ok: true, already: true };
      console.warn(`[tomco-queue] could not queue ${input.kind} ${input.opportunityId}: ${error.message}`);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      `[tomco-queue] threw queueing ${input.kind} ${input.opportunityId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Has the migration been applied yet?
 *
 * The migration for this table is run by hand (this project has no
 * SQL-over-REST), so there is a window where the code is deployed and the table
 * is not there. During it the per-minute cron would otherwise throw and log a
 * red line every sixty seconds, and the nightly sweep would report itself
 * broken — for a condition that is simply "not yet". Treated as an empty
 * queue instead: nothing is lost, because the sweep queues everything it finds
 * the first night after the table appears.
 */
export function isMissingQueueTable(message: string): boolean {
  return (
    new RegExp(TABLE, "i").test(message) &&
    /(does not exist|schema cache|relation|could not find the table)/i.test(message)
  );
}

export type QueueEntry = {
  id: string;
  kind: QueueKind;
  opportunityId: string;
  changeOrderId: string | null;
  attempts: number;
  queuedAt: string;
};

/**
 * How many times a single entry is retried before it is left alone.
 *
 * A rejection is usually permanent — a validation rule, a record type, a
 * missing work order — and retrying it every minute forever buries the real
 * failures in the Slack channel. Three attempts, then it waits for a person,
 * with `last_error` saying why.
 */
export const MAX_ATTEMPTS = 3;

/**
 * How long a held or failed entry waits before the tick looks at it again.
 *
 * NOT never, and not every minute. Both extremes are wrong:
 *
 *  - Never re-attempting a held entry until a person clears it would strand the
 *    self-clearing holds. "The deal is not in Salesforce yet" is the common one
 *    — a change order approved before its sale has synced — and it resolves on
 *    its own a minute later with nobody to clear anything.
 *  - Re-attempting every minute spends two or three SOQL queries a minute, per
 *    held entry, forever, to reach the same conclusion. A queue holding a
 *    genuinely ambiguous deal for a week would make 10,000 pointless calls
 *    against another company's org limits.
 *
 * So: an hour. And when a person DOES act on a hold in the review screen,
 * `releaseHold` clears the stamp so the very next tick picks it up — the wait
 * is a backstop, never the thing a human is waiting behind.
 */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** What the tick should work on, oldest first. */
export async function claimPending(limit = 20): Promise<QueueEntry[]> {
  const sb = adminClient();
  const waitUntil = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, kind, opportunity_id, change_order_id, attempts, queued_at, held_reason")
    .is("done_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    // Never attempted, or last attempted long enough ago. A brand-new entry has
    // no `last_attempt_at`, so this is what makes the sync immediate.
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${waitUntil}`)
    .order("queued_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (isMissingQueueTable(error.message)) return [];
    throw new Error(`write-back queue: ${error.message}`);
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as QueueKind,
    opportunityId: r.opportunity_id as string,
    changeOrderId: (r.change_order_id as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    queuedAt: r.queued_at as string,
  }));
}

export type QueueReviewRow = {
  id: string;
  kind: QueueKind;
  /** The deal, named the way every other surface names it. */
  label: string;
  queuedAt: string;
  attempts: number;
  heldReason: string | null;
  lastError: string | null;
  doneAt: string | null;
  outcome: string | null;
  /** Out of retries and not done: it has stopped asking. */
  stalled: boolean;
};

/**
 * The queue, for a person to look at.
 *
 * WHY THE SCREEN NEEDS THIS AT ALL: everything else about this feature is
 * invisible when it works. Without a surface showing what is waiting, a deal
 * held for a decision is held in a table nobody opens, and "it syncs
 * automatically" becomes an unverifiable claim. Read-only.
 */
export async function listQueueForReview(
  limit = 40,
): Promise<{ rows: QueueReviewRow[]; tableMissing: boolean }> {
  const sb = adminClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, kind, opportunity_id, change_order_id, queued_at, attempts, held_reason, last_error, done_at, outcome")
    // Pending first (done_at null sorts last ascending in Postgres, so order by
    // it descending with nulls first), then newest.
    .order("done_at", { ascending: false, nullsFirst: true })
    .order("queued_at", { ascending: false })
    .limit(limit);
  if (error) {
    /*
     * REPORTED, NOT SWALLOWED. The migration for this table is applied by hand,
     * and an empty list on this screen reads as "all clear" — the one thing it
     * must not say when it cannot tell. The caller renders the difference.
     */
    if (isMissingQueueTable(error.message)) return { rows: [], tableMissing: true };
    throw new Error(`write-back queue: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    id: string;
    kind: string;
    opportunity_id: string;
    change_order_id: string | null;
    queued_at: string;
    attempts: number | null;
    held_reason: string | null;
    last_error: string | null;
    done_at: string | null;
    outcome: string | null;
  }>;
  if (rows.length === 0) return { rows: [], tableMissing: false };

  /*
   * Names come from `derivedOppName`, like every other surface — a queue row
   * reading "a7172b3f-…" is a row nobody can act on, and a row reading a
   * DIFFERENT name from the deal page is worse than either.
   */
  const { data: deals } = await sb
    .from("commercial_opportunities")
    .select(
      "id, title, title_override, title_override_mode, client_name, property_street, account_id",
    )
    .in("id", [...new Set(rows.map((r) => r.opportunity_id))]);
  const acctIds = [...new Set((deals ?? []).map((d) => d.account_id).filter(Boolean))] as string[];
  const acctNames = new Map<string, string>();
  if (acctIds.length) {
    const { data: accts } = await sb.from("commercial_accounts").select("id, company_name").in("id", acctIds);
    for (const a of accts ?? []) acctNames.set(a.id as string, a.company_name as string);
  }
  const { derivedOppName } = await import("@/lib/commercial/opportunities/db");
  const titles = new Map<string, string>();
  for (const d of deals ?? []) {
    titles.set(
      d.id as string,
      derivedOppName(
        d as unknown as Parameters<typeof derivedOppName>[0],
        d.account_id ? acctNames.get(d.account_id as string) ?? null : null,
      ),
    );
  }

  const coNumbers = new Map<string, number | null>();
  const coIds = rows.map((r) => r.change_order_id).filter(Boolean) as string[];
  if (coIds.length) {
    const { data: cos } = await sb.from("commercial_change_orders").select("id, co_number").in("id", coIds);
    for (const c of cos ?? []) coNumbers.set(c.id as string, (c.co_number as number | null) ?? null);
  }

  const out = rows.map((r) => {
    const title = titles.get(r.opportunity_id) ?? r.opportunity_id.slice(0, 8);
    const co = r.change_order_id ? coNumbers.get(r.change_order_id) : null;
    return {
      id: r.id,
      kind: r.kind as QueueKind,
      label: r.kind === "change_order" ? `${title} · CO-${co ?? "?"}` : title,
      queuedAt: r.queued_at,
      attempts: Number(r.attempts ?? 0),
      heldReason: r.held_reason,
      lastError: r.last_error,
      doneAt: r.done_at,
      outcome: r.outcome,
      stalled: !r.done_at && Number(r.attempts ?? 0) >= MAX_ATTEMPTS,
    };
  });
  return { rows: out, tableMissing: false };
}

/** Finished — written, or decided that nothing was needed. */
export async function markDone(id: string, outcome: string): Promise<void> {
  const sb = adminClient();
  await sb
    .from(TABLE)
    .update({ done_at: new Date().toISOString(), outcome, last_error: null, held_reason: null })
    .eq("id", id);
}

/**
 * Waiting on a person.
 *
 * NOT counted as an attempt. A held deal is not a failure and must not burn
 * through the retry budget — it would then be abandoned before anybody had a
 * chance to clear it in the review screen.
 */
export async function markHeld(id: string, reason: string): Promise<void> {
  const sb = adminClient();
  await sb
    .from(TABLE)
    .update({ held_reason: reason, last_attempt_at: new Date().toISOString() })
    .eq("id", id);
}

/**
 * A person has just made the decision the entry was waiting for — look at it
 * NOW rather than at the end of the back-off.
 *
 * Called from the review screen's own actions (pairing a deal, marking it new).
 * Without it, somebody clears a hold and then watches nothing happen for up to
 * an hour, which is how a review queue stops being trusted.
 *
 * Never throws, for the same reason `queueForWriteBack` does not: a decision
 * must be recorded even if the queue cannot be nudged. The back-off then does
 * what it always does, an hour later.
 */
export async function releaseHold(opportunityId: string): Promise<void> {
  try {
    const sb = adminClient();
    await sb
      .from(TABLE)
      .update({ held_reason: null, last_attempt_at: null })
      .eq("opportunity_id", opportunityId)
      .is("done_at", null);
  } catch (err) {
    console.warn(
      `[tomco-queue] could not release the hold on ${opportunityId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Tried and failed. Counts against the budget. */
export async function markFailed(id: string, attempts: number, error: string): Promise<void> {
  const sb = adminClient();
  await sb
    .from(TABLE)
    .update({ attempts: attempts + 1, last_attempt_at: new Date().toISOString(), last_error: error })
    .eq("id", id);
}
