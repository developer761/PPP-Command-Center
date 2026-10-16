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

/**
 * The table is there but a COLUMN this code needs is not — the window between
 * deploying a change and running its migration by hand.
 *
 * 🔴 WHY THIS IS NOT THE SAME CHECK. `isMissingQueueTable` keys on the table
 * name, and PostgREST's message for a missing column names the COLUMN
 * ("column commercial_tomco_writeback_queue.claimed_at does not exist" does
 * mention both, but "Could not find the 'claimed_at' column of … in the schema
 * cache" need not). The atomic claim added `claimed_at`, and without this the
 * per-minute cron would throw and log a red 500 every sixty seconds from the
 * moment the code deployed until somebody ran the SQL — which is precisely the
 * noise that gets a real failure ignored.
 *
 * Treated as "not ready yet", exactly like a missing table: nothing is lost,
 * because the nightly sweep queues everything it finds once the column exists.
 */
export function isMissingQueueColumn(message: string): boolean {
  return /(column|could not find).*(claimed_at|verify_failed_at|verify_failed_reason)/i.test(message)
    || /(claimed_at|verify_failed_at|verify_failed_reason).*(does not exist|schema cache)/i.test(message);
}

/** Either flavour of "the migration has not been run yet". */
export function isQueueNotReady(message: string): boolean {
  return isMissingQueueTable(message) || isMissingQueueColumn(message);
}

export type QueueEntry = {
  id: string;
  kind: QueueKind;
  opportunityId: string;
  changeOrderId: string | null;
  /**
   * Attempts spent BEFORE this claim.
   *
   * 🔴 NOT what the row now holds. `claimPending` writes `attempts + 1` as part
   * of taking the entry (see its docblock), so the database is already one
   * ahead of this number. This is the pre-claim value because it is the only
   * one the two callers can use: `markFailed` re-asserts `this + 1` — the same
   * number the claim wrote, so a failure does not spend a second attempt — and
   * `markHeld` writes `this` back, refunding the claim because a hold is not a
   * failure.
   */
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
 *
 * COUNTED FROM THE CLAIM, NOT FROM THE FAILURE. `attempts` is "times this entry
 * has been STARTED", which is why it bounds a crash as well as a rejection —
 * see `claimPending`. The visible consequence: an entry in flight already shows
 * its attempt spent, and an entry on its third attempt reads as stalled for the
 * ten to twenty seconds it is being worked on. That is the honest reading: if
 * the tick dies in those seconds, stalled is exactly what it is.
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
 * The longest the cron route may be allowed to run.
 *
 * 🔴 THIS IS THE LINK BETWEEN TWO FILES THAT NOTHING USED TO STATE.
 *
 * The claim in `claimPending` is what stops two ticks working the same entry,
 * and `CLAIM_STALE_MS` is what stops a dead tick's claim being honoured for
 * ever. Those two only coexist while a LIVE tick cannot outlast its own claim.
 * Today that holds for one reason and one reason only: the route declares
 * `maxDuration = 300` and Vercel kills it there, which is under the ten-minute
 * staleness window. Raise `maxDuration` past it — a plausible thing to do when
 * the queue gets deep — and a tick is still mid-entry when its claim expires,
 * a second tick claims the same row, and both reach `syncChangeOrder` with no
 * link and no matching amount. That is the exact shape that creates two
 * `ChangeOrder__c` records for one piece of work and doubles
 * `TotalChangeOrder__c`; Salesforce has no unique external id on that object
 * and will not refuse the second one.
 *
 * Half the window, not all of it: the other half is slack for the platform to
 * actually stop the function, for clock skew between the two writers, and for
 * the round trip that releases the claim. Asserted — a comment hoping somebody
 * reads it is what we had.
 *
 * @see __tests__/commercial/a-tick-cannot-outlast-its-own-claim.test.ts
 */
export const MAX_TICK_SECONDS = CLAIM_STALE_MS / 2000;

/**
 * The same set `claimPending` would take, WITHOUT claiming any of it.
 *
 * For plan runs. `claimPending` stamps `claimed_at` and only the apply path
 * releases it, so a dry run that claimed would strand entries for ten minutes
 * and then report an EMPTY queue on its second run — a preview that changes
 * the thing it is previewing.
 */
export async function peekPending(limit = 20): Promise<QueueEntry[]> {
  const sb = adminClient();
  const waitUntil = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, kind, opportunity_id, change_order_id, attempts, queued_at")
    .is("done_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${waitUntil}`)
    .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
    .order("queued_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (isQueueNotReady(error.message)) return [];
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
 *
 * 🔴 AND IT SPENDS THE ATTEMPT, HERE, RATHER THAN ON FAILURE.
 *
 * `attempts` used to be written only by `markFailed` — which runs only if the
 * tick SURVIVES to call it. An entry that KILLS the tick spends nothing: a
 * `maxDuration` overrun, an out-of-memory, a deploy landing mid-flight. The
 * row keeps `claimed_at`, goes stale after `CLAIM_STALE_MS`, is re-claimed
 * with `attempts` untouched, kills the next tick the same way, and does it
 * again every ten minutes for ever — re-running real Salesforce writes each
 * cycle. `MAX_ATTEMPTS` cannot bound a failure mode whose whole nature is that
 * the counter never gets written.
 *
 * So the attempt is spent as part of TAKING the entry, in the same conditional
 * UPDATE that claims it, which makes it unskippable: nothing that happens
 * afterwards can prevent it. The two invariants that already existed are kept
 * by making the other two writers absolute rather than relative —
 *
 *  - A FAILURE SPENDS EXACTLY ONE. `markFailed` writes `attemptsBeforeClaim +
 *    1`, which is the number this claim already wrote. Same value, written
 *    twice; the budget moves by one per claim-and-fail cycle, as before.
 *  - A HOLD SPENDS NOTHING. `markHeld` writes `attemptsBeforeClaim` back,
 *    refunding the claim. Without that refund a deal waiting on Katie would be
 *    re-claimed hourly, run out of retries in three hours, and be abandoned
 *    before anybody could clear it — the one thing the hold exists to prevent.
 *
 * Both are safe to write absolutely for the same reason `markFailed` already
 * was: the claim is atomic, so exactly one tick owns the row.
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
    if (isQueueNotReady(error.message)) return [];
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
    const attemptsBeforeClaim = Number(row.attempts ?? 0);
    let q = sb
      .from(TABLE)
      .update({
        claimed_at: new Date().toISOString(),
        // Spent here, not on failure. See the docblock.
        attempts: attemptsBeforeClaim + 1,
      })
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
      // Deliberately the PRE-claim number — see `QueueEntry.attempts`.
      attempts: attemptsBeforeClaim,
      queuedAt: row.queued_at,
    });
  }
  return mine;
}

export type QueueReviewRow = {
  id: string;
  kind: QueueKind;
  /** The change order itself, for the actions that act on one. */
  changeOrderId: string | null;
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
  /**
   * Held, and parked until a person acts — never re-tried on a timer. See
   * `markHeld`'s `waitsFor: "person"`.
   */
  waitingForPerson: boolean;
  /** A read-back disagreed with what was written, and nothing has since proved
   *  otherwise. Survives the entry being marked done — that is the point. */
  verifyFailedAt: string | null;
  verifyFailedReason: string | null;
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
  opts: { recentDone?: number } = {},
): Promise<{ rows: QueueReviewRow[]; tableMissing: boolean }> {
  const sb = adminClient();
  const COLS =
    "id, kind, opportunity_id, change_order_id, queued_at, attempts, held_reason, last_error, done_at, outcome, verify_failed_at, verify_failed_reason";
  /*
   * 🔴 EVERY ROW THAT NEEDS SOMEBODY, NOT THE FIRST 40.
   *
   * This was one `.limit(40)` over the whole table, and the screen's tiles —
   * waiting, needs a person, stopped asking, not verified — were counted from
   * those 40. With 117 rows in the table, a held or unverified entry outside
   * the newest 40 was in no tile and on no list: the review screen said "0
   * not verified" about a write whose read-back had failed. So: every pending
   * row and every unverified row, PAGED, plus the most recent finished ones
   * for context. The tiles are now counts of the whole table.
   */
  const readAll = async (filter: "pending" | "unverified") => {
    const out: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(TABLE).select(COLS);
      q = filter === "pending" ? q.is("done_at", null) : q.not("verify_failed_at", "is", null);
      const { data, error } = await q.order("queued_at", { ascending: false }).range(from, from + 999);
      if (error) return { error };
      out.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    return { data: out };
  };
  const pending = await readAll("pending");
  const unverified = "error" in pending ? pending : await readAll("unverified");
  const recent =
    "error" in unverified
      ? unverified
      : await sb
          .from(TABLE)
          .select(COLS)
          .not("done_at", "is", null)
          .order("done_at", { ascending: false })
          .limit(opts.recentDone ?? 25);
  const error = ("error" in pending && pending.error) || ("error" in unverified && unverified.error) || ("error" in recent && recent.error) || null;
  if (error) {
    /*
     * REPORTED, NOT SWALLOWED. The migration for this table is applied by hand,
     * and an empty list on this screen reads as "all clear" — the one thing it
     * must not say when it cannot tell. The caller renders the difference.
     */
    if (isQueueNotReady(error.message)) return { rows: [], tableMissing: true };
    throw new Error(`write-back queue: ${error.message}`);
  }
  const seen = new Set<string>();
  const data: unknown[] = [];
  for (const r of [
    ...((pending as { data: unknown[] }).data ?? []),
    ...((unverified as { data: unknown[] }).data ?? []),
    ...(((recent as { data: unknown[] | null }).data ?? []) as unknown[]),
  ]) {
    const id = (r as { id: string }).id;
    if (seen.has(id)) continue;
    seen.add(id);
    data.push(r);
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
    verify_failed_at: string | null;
    verify_failed_reason: string | null;
  }>;
  if (rows.length === 0) return { rows: [], tableMissing: false };

  /*
   * Names come from `derivedOppName`, like every other surface — a queue row
   * reading "a7172b3f-…" is a row nobody can act on, and a row reading a
   * DIFFERENT name from the deal page is worse than either.
   */
  const dealIds = [...new Set(rows.map((r) => r.opportunity_id))];
  const deals: Array<Record<string, unknown>> = [];
  for (let i = 0; i < dealIds.length; i += 200) {
    const { data: part, error: dErr } = await sb
      .from("commercial_opportunities")
      .select("id, title, title_override, title_override_mode, client_name, property_street, account_id")
      .in("id", dealIds.slice(i, i + 200));
    if (dErr) throw new Error(`write-back queue names: ${dErr.message}`);
    deals.push(...((part ?? []) as Array<Record<string, unknown>>));
  }
  const acctIds = [...new Set((deals ?? []).map((d) => d.account_id).filter(Boolean))] as string[];
  const acctNames = new Map<string, string>();
  for (let i = 0; i < acctIds.length; i += 200) {
    const { data: accts } = await sb.from("commercial_accounts").select("id, company_name").in("id", acctIds.slice(i, i + 200));
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
  const coIds = [...new Set(rows.map((r) => r.change_order_id).filter(Boolean) as string[])];
  for (let i = 0; i < coIds.length; i += 200) {
    const { data: cos } = await sb.from("commercial_change_orders").select("id, co_number").in("id", coIds.slice(i, i + 200));
    for (const c of cos ?? []) coNumbers.set(c.id as string, (c.co_number as number | null) ?? null);
  }

  const out = rows.map((r) => {
    const title = titles.get(r.opportunity_id) ?? r.opportunity_id.slice(0, 8);
    const co = r.change_order_id ? coNumbers.get(r.change_order_id) : null;
    return {
      id: r.id,
      kind: r.kind as QueueKind,
      changeOrderId: r.change_order_id ?? null,
      label: r.kind === "change_order" ? `${title} · CO-${co ?? "?"}` : title,
      queuedAt: r.queued_at,
      attempts: Number(r.attempts ?? 0),
      heldReason: r.held_reason,
      lastError: r.last_error,
      doneAt: r.done_at,
      outcome: r.outcome,
      stalled: !r.done_at && Number(r.attempts ?? 0) >= MAX_ATTEMPTS && !r.held_reason,
      waitingForPerson: !r.done_at && Number(r.attempts ?? 0) >= MAX_ATTEMPTS && !!r.held_reason,
      verifyFailedAt: r.verify_failed_at ?? null,
      verifyFailedReason: r.verify_failed_reason ?? null,
    };
  });
  return { rows: out, tableMissing: false };
}

/**
 * What `done_at` should say: the instant the data that was written was READ,
 * never the instant the writing stopped.
 *
 * 🔴 A LOST-UPDATE WINDOW, CLOSED BY A TIMESTAMP.
 *
 * `done_at` has exactly one consumer that decides anything: `needsRequeue`,
 * which asks the nightly sweep "has this thing changed HERE since the last
 * entry finished?" and re-queues when `updated_at > done_at`. But the entry
 * did not read the deal when it finished — it read it ten to twenty seconds
 * earlier, before several Salesforce round trips and the six-second wait for
 * the rollups. An edit landing inside that window is written to the database
 * with an `updated_at` BELOW the `done_at` that is about to be stamped, so the
 * sweep concludes nothing has changed since and the edit is never swept.
 * Nothing retries it, nothing reports it, and Salesforce keeps the pre-edit
 * figure for ever.
 *
 * So the stamp is the read instant. Everything the entry looked at was read at
 * or after it, so any edit the write could have missed sorts after it and the
 * sweep picks the thing up tomorrow night. The cost is that the review screen
 * shows an entry finishing a few seconds before it did, which is the cheaper
 * of the two lies by a wide margin.
 *
 * Clamped to now, and falling back to now, so a caller that passes a garbage
 * or future timestamp cannot stamp a completion that has not happened — that
 * would park the row ahead of every future edit and lose the sweep entirely.
 */
export function completionStamp(readAt?: string | null, now: Date = new Date()): string {
  if (!readAt) return now.toISOString();
  const t = Date.parse(readAt);
  if (!Number.isFinite(t) || t > now.getTime()) return now.toISOString();
  return new Date(t).toISOString();
}

/**
 * Finished — written, or decided that nothing was needed.
 *
 * `readAt` is the instant the tick started looking at this entry, and it is
 * what lands in `done_at`. See `completionStamp` for why that is not the same
 * as "when this call ran", and why the difference is a lost edit.
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
  opts: { verified?: boolean; readAt?: string | null } = {},
): Promise<void> {
  const sb = adminClient();
  const patch: Record<string, unknown> = {
    done_at: completionStamp(opts.readAt),
    outcome,
    last_error: null,
    held_reason: null,
    claimed_at: null,
  };
  if (opts.verified) {
    patch.verify_failed_at = null;
    patch.verify_failed_reason = null;
  }
  // Reported, not swallowed: a markDone that silently failed leaves the entry
  // pending, and the next tick writes the same thing to Salesforce again.
  await mustTouchOne(sb.from(TABLE).update(patch).eq("id", id).select("id"), `mark ${id} done`);
}

/**
 * 🔴 AN UPDATE THAT MATCHED NOTHING IS NOT A SUCCESS (F38).
 *
 * Every writer here did `const { error } = await …update(…).eq("id", id)` and
 * treated "no error" as done. PostgREST reports an update that matched ZERO
 * rows as success — so a mark against a row that had been deleted, or an id
 * that was never right, vanished without a word, and the tick reported the
 * entry finished. The probe script hit exactly this: it deleted its own row
 * mid-run and every mark after that "succeeded".
 *
 * Throws, so the tick's per-entry catch records it as a failure rather than a
 * finish. Exported for `npm run check:writeback`, which proves it can fail.
 */
export async function mustTouchOne(
  q: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  what: string,
): Promise<void> {
  const { data, error } = await q;
  if (error) throw new Error(`[tomco-queue] could not ${what}: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`[tomco-queue] could not ${what}: no such queue entry (0 rows matched)`);
}

/**
 * A read-back disagreed with what we just wrote.
 *
 * Recorded separately from `last_error` because it must OUTLIVE the entry being
 * marked done. See `markDone`.
 */
export async function markVerifyFailed(id: string, reason: string): Promise<void> {
  const sb = adminClient();
  await mustTouchOne(
    sb
      .from(TABLE)
      .update({ verify_failed_at: new Date().toISOString(), verify_failed_reason: reason.slice(0, 2000) })
      .eq("id", id)
      .select("id"),
    `record the failed verification on ${id}`,
  );
}

/**
 * Waiting on a person.
 *
 * NOT counted as an attempt. A held deal is not a failure and must not burn
 * through the retry budget — it would then be abandoned before anybody had a
 * chance to clear it in the review screen.
 *
 * 🔴 WHICH NOW TAKES A REFUND, NOT JUST AN OMISSION. The claim spends the
 * attempt (see `claimPending`), so "do not increment" is no longer the same
 * thing as "do not spend". A hold sets `last_attempt_at`, the entry is
 * re-claimable an hour later, and three hours of waiting on Katie would stall
 * a deal nobody had failed to write. So `attemptsBeforeClaim` — the number the
 * tick read when it took the entry — is written back.
 *
 * Optional only for the direct callers that never claimed anything; the tick
 * always passes it.
 */
export async function markHeld(
  id: string,
  reason: string,
  opts: {
    attemptsBeforeClaim?: number;
    /**
     * WHAT THE HOLD IS WAITING FOR (F38).
     *
     * `"event"` — something that happens on its own: the sale this change
     * order belongs to reaching Salesforce, the org creating a work order from
     * a synced quote. Re-checked on the hourly back-off, attempts refunded.
     *
     * `"person"` — a decision only a human can make: is this the same sale,
     * what happens to a deleted job's Salesforce record, which of two equal
     * change orders is this one. These used to be re-checked hourly for ever,
     * two or three SOQL queries a time against Tomco's org, to reach the same
     * answer, with nobody told. Now the entry is PARKED — `attempts` set to
     * `MAX_ATTEMPTS`, the same idiom the probe uses to make a row unclaimable —
     * and it waits, without a timer, for the review screen's action
     * (`releaseHold`, `releaseHoldForChangeOrder`, `rearmStalled`).
     */
    waitsFor?: "event" | "person";
  } = {},
): Promise<void> {
  const sb = adminClient();
  const patch: Record<string, unknown> = {
    held_reason: reason,
    last_attempt_at: new Date().toISOString(),
    // The claim is released: a held entry is not being worked on.
    claimed_at: null,
  };
  if (opts.waitsFor === "person") patch.attempts = MAX_ATTEMPTS;
  else if (typeof opts.attemptsBeforeClaim === "number") patch.attempts = opts.attemptsBeforeClaim;
  await mustTouchOne(sb.from(TABLE).update(patch).eq("id", id).select("id"), `hold ${id}`);
}

/**
 * How long an event-hold may wait on its own before a person is asked.
 *
 * "The deal is not in Salesforce yet" clears within the minute when the sale
 * syncs — unless the sale is itself waiting on somebody, in which case it
 * never clears and used to be re-asked every hour indefinitely. A day is far
 * past any real lag in the org's automation.
 */
export const EVENT_HOLD_MAX_MS = 24 * 60 * 60 * 1000;

/** Pure: has an event-hold waited long enough to need a person? */
export function eventHoldHasExpired(queuedAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(queuedAt);
  return Number.isFinite(t) && now - t > EVENT_HOLD_MAX_MS;
}

/**
 * The sale for this deal has just reached Salesforce — look again NOW at the
 * change orders that were waiting for it, rather than at the end of the hour.
 * Only event-holds: a change order parked for a person stays parked.
 */
export async function nudgeChangeOrdersWaitingOnSale(opportunityId: string): Promise<void> {
  try {
    const sb = adminClient();
    await sb
      .from(TABLE)
      .update({ last_attempt_at: null })
      .eq("opportunity_id", opportunityId)
      .eq("kind", "change_order")
      .is("done_at", null)
      .lt("attempts", MAX_ATTEMPTS)
      .not("held_reason", "is", null);
  } catch (err) {
    console.warn(`[tomco-queue] could not nudge change orders on ${opportunityId}:`, err instanceof Error ? err.message : String(err));
  }
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
    // A held entry may be PARKED for a person (attempts = MAX_ATTEMPTS); the
    // person has now acted, so it gets its budget back. Only held entries — a
    // genuinely stalled failure is not this decision's to rearm.
    await sb
      .from(TABLE)
      .update({ held_reason: null, last_attempt_at: null, attempts: 0 })
      .eq("opportunity_id", opportunityId)
      .is("done_at", null)
      .not("held_reason", "is", null);
  } catch (err) {
    console.warn(
      `[tomco-queue] could not release the hold on ${opportunityId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The change-order equivalent of `releaseHold`: a person has answered the
 * question this entry was waiting on, so look at it on the next tick rather
 * than at the end of the hour-long back-off.
 */
export async function releaseHoldForChangeOrder(changeOrderId: string): Promise<void> {
  try {
    const sb = adminClient();
    await sb
      .from(TABLE)
      .update({ held_reason: null, last_attempt_at: null, attempts: 0 })
      .eq("change_order_id", changeOrderId)
      .is("done_at", null)
      .not("held_reason", "is", null);
  } catch (err) {
    console.warn(
      `[tomco-queue] could not release the hold on change order ${changeOrderId}:`,
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
 *
 * 🔴 IT RE-ASSERTS THE CLAIM'S NUMBER; IT DOES NOT ADD A SECOND ONE. Since
 * `claimPending` writes `attemptsBeforeClaim + 1` as it takes the entry, this
 * writes the value the row already holds. That is deliberate rather than
 * redundant: the two paths out of a claim — failed, or died before it could
 * say so — must cost exactly the same one attempt, and making this absolute
 * rather than `attempts + 1`-from-the-row is what guarantees it.
 */
export async function markFailed(id: string, attemptsBeforeClaim: number, error: string): Promise<void> {
  const sb = adminClient();
  // 🔴 Reported. A markFailed that silently did nothing means `attempts` never
  // advances, so the entry is retried every hour for ever and never reaches the
  // "stopped asking" state a person is meant to see.
  await mustTouchOne(
    sb
      .from(TABLE)
      .update({
        attempts: attemptsBeforeClaim + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: error.slice(0, 2000),
        claimed_at: null,
      })
      .eq("id", id)
      .select("id"),
    `record the failure on ${id}`,
  );
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
  /*
   * Also the "Re-check" behind an entry PARKED for a person: the person has
   * done what the hold asked (created the account in Salesforce, finished a
   * half-built sale), so the reason is cleared and the next tick decides again.
   * If the condition still holds, the tick simply parks it again.
   */
  const { data, error } = await sb
    .from(TABLE)
    .update({ attempts: 0, last_attempt_at: null, last_error: null, claimed_at: null, held_reason: null })
    .eq("id", id)
    .is("done_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "That entry is no longer waiting — it may already have finished." };
  return { ok: true };
}
