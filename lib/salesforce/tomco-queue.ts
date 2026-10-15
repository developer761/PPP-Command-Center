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

/**
 * How long a claim is honoured before another tick may take the entry.
 *
 * A tick that dies mid-entry — the lambda hitting `maxDuration`, a deploy
 * mid-flight — leaves `claimed_at` set and nothing to clear it. Without a
 * staleness window that entry would never be touched again. Ten minutes is far
 * longer than the worst realistic entry (about twenty seconds) and far shorter
 * than the hour an entry waits between attempts anyway.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Take up to `limit` entries, ATOMICALLY, and return only the ones this caller
 * now owns.
 *
 * 🔴 THE CLAIM IS THE WHOLE POINT. This used to be a plain SELECT, and nothing
 * marked a row as taken until its processing finished — ten to twenty seconds
 * later, because every entry waits six seconds for Salesforce's rollups before
 * reading back. The cron fires every sixty seconds and a batch of ten takes up
 * to 200s, so two ticks overlapped as a matter of course and the second re-read
 * entries the first was still working on.
 *
 * What that cost, concretely: two ticks inside `syncChangeOrder` for the same
 * change order both find no link, both find nothing at the matching amount, and
 * both create a `ChangeOrder__c`. Two approved change orders for one piece of
 * work, `TotalChangeOrder__c` doubled, and nothing in Salesforce to refuse it.
 *
 * The claim is one conditional UPDATE per candidate: it applies only while
 * `claimed_at` is still what we read, so of two ticks racing for a row exactly
 * one gets it back and the other sees no row and moves on.
 */
export async function claimPending(limit = 20): Promise<QueueEntry[]> {
  const sb = adminClient();
  const waitUntil = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, kind, opportunity_id, change_order_id, attempts, queued_at, held_reason, claimed_at")
    .is("done_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    // Never attempted, or last attempted long enough ago. A brand-new entry has
    // no `last_attempt_at`, so this is what makes the sync immediate.
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${waitUntil}`)
    // Unclaimed, or claimed by a tick that has evidently died.
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .order("queued_at", { ascending: true })
    // Ask for more than we need: some of these will be lost to another tick.
    .limit(limit * 2);
  if (error) {
    if (isMissingQueueTable(error.message)) return [];
    throw new Error(`write-back queue: ${error.message}`);
  }

  const mine: QueueEntry[] = [];
  for (const r of data ?? []) {
    if (mine.length >= limit) break;
    const row = r as {
      id: string;
      kind: string;
      opportunity_id: string;
      change_order_id: string | null;
      attempts: number | null;
      queued_at: string;
      claimed_at: string | null;
    };
    /*
     * The compare-and-swap. `.is("claimed_at", null)` or `.eq` on the exact
     * value we read means the update matches at most once — whoever gets the
     * row back owns it, and the loser gets an empty result rather than an error.
     */
    let q = sb
      .from(TABLE)
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("done_at", null);
    q = row.claimed_at === null ? q.is("claimed_at", null) : q.eq("claimed_at", row.claimed_at);
    const { data: won, error: claimErr } = await q.select("id").maybeSingle();
    if (claimErr) {
      // Could not claim: leave it for the next tick rather than risk working on
      // an entry we do not own.
      console.warn(`[tomco-queue] could not claim ${row.id}: ${claimErr.message}`);
      continue;
    }
    if (!won) continue; // another tick got there first
    mine.push({
      id: row.id,
      kind: row.kind as QueueKind,
      opportunityId: row.opportunity_id,
      changeOrderId: row.change_order_id ?? null,
      attempts: Number(row.attempts ?? 0),
      queuedAt: row.queued_at,
    });
  }
  return mine;
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

/**
 * Finished — written, or decided that nothing was needed.
 *
 * `verified` says whether a read-back actually confirmed it. 🔴 THE DEFAULT IS
 * FALSE AND THAT MATTERS: a write whose read-back disagreed used to be marked
 * failed, and then an hour later the retry found Salesforce already in its new
 * state, returned "nothing to do", and marked the entry done — clearing
 * `last_error` on the way. The entry went green and the evidence vanished,
 * which is how a sale sitting at $0 in Katie's reports read as a clean sync.
 *
 * So `verify_failed_at` is cleared ONLY by a passing read-back. Marking an
 * entry done leaves it standing, and the review screen shows it.
 */
export async function markDone(
  id: string,
  outcome: string,
  opts: { verified?: boolean } = {},
): Promise<void> {
  const sb = adminClient();
  const patch: Record<string, unknown> = {
    done_at: new Date().toISOString(),
    outcome,
    last_error: null,
    held_reason: null,
    claimed_at: null,
  };
  if (opts.verified) {
    patch.verify_failed_at = null;
    patch.verify_failed_reason = null;
  }
  const { error } = await sb.from(TABLE).update(patch).eq("id", id);
  // Reported, not swallowed: a markDone that silently failed leaves the entry
  // pending, and the next tick writes the same thing to Salesforce again.
  if (error) console.warn(`[tomco-queue] could not mark ${id} done: ${error.message}`);
}

/**
 * A read-back disagreed with what we just wrote.
 *
 * Recorded separately from `last_error` because it must OUTLIVE the entry being
 * marked done. See `markDone`.
 */
export async function markVerifyFailed(id: string, reason: string): Promise<void> {
  const sb = adminClient();
  const { error } = await sb
    .from(TABLE)
    .update({ verify_failed_at: new Date().toISOString(), verify_failed_reason: reason.slice(0, 2000) })
    .eq("id", id);
  if (error) console.warn(`[tomco-queue] could not record the failed verification on ${id}: ${error.message}`);
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
  const { error } = await sb
    .from(TABLE)
    // The claim is released: a held entry is not being worked on.
    .update({ held_reason: reason, last_attempt_at: new Date().toISOString(), claimed_at: null })
    .eq("id", id);
  if (error) console.warn(`[tomco-queue] could not hold ${id}: ${error.message}`);
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

/**
 * Tried and failed. Counts against the budget.
 *
 * `attempts + 1` from the value read at claim time is safe now that the claim
 * is atomic — only one tick holds the entry, so there is no second writer to
 * lose an update to.
 */
export async function markFailed(id: string, attempts: number, error: string): Promise<void> {
  const sb = adminClient();
  const { error: err } = await sb
    .from(TABLE)
    .update({
      attempts: attempts + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: error.slice(0, 2000),
      claimed_at: null,
    })
    .eq("id", id);
  // 🔴 Reported. A markFailed that silently did nothing means `attempts` never
  // advances, so the entry is retried every hour for ever and never reaches the
  // "stopped asking" state a person is meant to see.
  if (err) console.warn(`[tomco-queue] could not record the failure on ${id}: ${err.message}`);
}

/**
 * Put a stalled entry back in the queue.
 *
 * An entry that spent its three attempts is never claimed again
 * (`claimPending` filters `attempts < MAX_ATTEMPTS`) and the nightly sweep
 * cannot rescue it either — `needsRequeue` declines anything still pending, and
 * the partial unique index would refuse a fresh row anyway. So without this it
 * is stuck for good AND it blocks every future entry for that deal, with no
 * remedy but hand-editing the table. The review screen shows those rows in red;
 * this is what the button behind them does.
 */
export async function rearmStalled(id: string): Promise<{ ok: boolean; error?: string }> {
  const sb = adminClient();
  const { error } = await sb
    .from(TABLE)
    .update({ attempts: 0, last_attempt_at: null, last_error: null, claimed_at: null })
    .eq("id", id)
    .is("done_at", null);
  return error ? { ok: false, error: error.message } : { ok: true };
}
