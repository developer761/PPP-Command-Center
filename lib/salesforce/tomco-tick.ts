import "server-only";

import { getSalesforceClient, isSalesforceConfigured } from "@/lib/salesforce/client";
import {
  claimPending,
  eventHoldHasExpired,
  markDone,
  markFailed,
  markHeld,
  markVerifyFailed,
  nudgeChangeOrdersWaitingOnSale,
  peekPending,
  type QueueEntry,
} from "@/lib/salesforce/tomco-queue";
import { decideWriteBack } from "@/lib/salesforce/tomco-decide";
import {
  isSoldStatus,
  listOpenSalesforceCandidates,
  listResolvedDeals,
  loadSoldDeal,
  type SfCandidate,
} from "@/lib/salesforce/tomco-pairing";
import { CREATED_LINK_NOTE, createNew, updateExisting } from "@/lib/salesforce/tomco-writeback";
import { CO_MAP_ENTITY, ROLLUP_TITLE, syncChangeOrder } from "@/lib/salesforce/tomco-changeorder";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { assertSalesforceId, soqlString } from "@/lib/salesforce/soql";

/**
 * The tick: everything waiting in the queue, written to Salesforce.
 *
 * This is the half of the real-time sync that talks to Salesforce. The other
 * half is one local insert at the moment of the change (see
 * `queueForWriteBack`), and the split is the whole design:
 *
 *   deal marked sold / change order approved
 *     └→ queued instantly — one indexed insert, cannot hang, cannot fail
 *          └→ this, once a minute — decides, writes, reads back, verifies
 *               └→ the nightly sweep — anything that failed, was held then
 *                  cleared, or happened while Salesforce was down
 *
 * THREE BEHAVIOURS WORTH NAMING, because they are the ones a reader will
 * assume wrongly:
 *
 *  1. A HELD entry STAYS HELD. `decideWriteBack` holds a deal that might
 *     already be in Salesforce under another name, and holding does not count
 *     as an attempt — so it waits for the review screen indefinitely rather
 *     than being retried until it is abandoned. A machine must not resolve
 *     "is this the same sale?"; that is what double-counted $97,000 once.
 *  2. RETRIES ARE BOUNDED — INCLUDING THE ONES THAT KILL THIS FUNCTION. Three
 *     attempts (`MAX_ATTEMPTS`), then the entry stops asking and `last_error`
 *     says why. The attempt is spent by `claimPending` as it takes the entry,
 *     not by `markFailed` on the way out, precisely so that an entry which
 *     overruns `maxDuration` or catches a deploy mid-flight still costs one:
 *     a counter written only on the way out cannot bound a failure that stops
 *     you getting there. A hold refunds it — see `markHeld`.
 *  3. IT RE-ATTEMPTS RATHER THAN FIRING ONCE. Nothing here is "the one chance"
 *     a sale had to reach Salesforce. An entry that fails is still pending, and
 *     the next tick picks it up.
 */

/** How many entries one tick will take on. */
const PER_TICK = 10;

export type TickOutcome = {
  entryId: string;
  kind: QueueEntry["kind"];
  label: string;
  result: "written" | "nothing" | "held" | "failed";
  detail: string;
};

export type TickSummary = {
  ok: boolean;
  claimed: number;
  written: number;
  nothing: number;
  held: number;
  failed: number;
  /** Set when the whole tick could not run — no Salesforce, for instance. */
  skipped?: string;
  outcomes: TickOutcome[];
};

function admin() {
  return createSupabaseAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The Salesforce opportunity this deal is linked to, if any.
 *
 * 🔴 A FAILED READ THROWS; IT IS NEVER "NOT LINKED" (F23 b).
 *
 * This dropped `error`, so a Supabase blip read as `null` — "Salesforce has
 * never had this deal" — and the tick took the INSERT path for a deal that was
 * already a Closed Won sale over there. For one imported from Salesforce the
 * external-id lookup cannot catch it (the importer never stamped one), so the
 * result was a second Closed Won opportunity in Katie's total. A throw is
 * caught per entry, spends an attempt, and writes nothing.
 *
 * `maybeSingle` also errors on two link rows for one deal — which is a real
 * ambiguity, and refusing on it is right.
 */
export async function pairedLinkFor(opportunityId: string): Promise<{ sfId: string; notes: string | null } | null> {
  const { data, error } = await admin()
    .from("commercial_import_map")
    .select("sf_id, notes")
    .eq("entity", "deal")
    .eq("row_id", opportunityId)
    .maybeSingle();
  if (error) throw new Error(`could not read this deal's Salesforce link (${error.message}) — nothing written`);
  const row = data as { sf_id?: string; notes?: string | null } | null;
  return row?.sf_id ? { sfId: row.sf_id, notes: row.notes ?? null } : null;
}

/**
 * Hold an entry, on the right clock, and tell a person when one is needed.
 *
 * See `markHeld` for the two kinds. An event-hold that has waited past
 * `EVENT_HOLD_MAX_MS` is turned into a person-hold here: whatever it was
 * waiting for is not coming on its own.
 */
async function holdEntry(
  ctx: { apply: boolean },
  entry: QueueEntry,
  label: string,
  why: string,
  waitsFor: "event" | "person",
): Promise<string> {
  let reason = why;
  let kind = waitsFor;
  if (kind === "event" && eventHoldHasExpired(entry.queuedAt)) {
    kind = "person";
    reason = `Still waiting after a day, so a person is needed: ${why}`;
  }
  if (!ctx.apply) return reason;
  await markHeld(entry.id, reason, { attemptsBeforeClaim: entry.attempts, waitsFor: kind });
  if (kind === "person") {
    /*
     * ONE alert per hold. A person-hold is parked — never re-claimed on a
     * timer — so this runs once, when it is parked, and again only if a
     * person re-checks it and the reason still stands.
     */
    void import("@/lib/commercial/slack-notify")
      .then(({ postCommercialSlack }) =>
        postCommercialSlack({
          text: `*Tomco write-back needs a person* — ${label}`,
          context: reason.slice(0, 600),
          url: "/dashboard/settings/writeback/tomco",
          urlLabel: "Open the review screen",
          tone: "needs_action",
        }),
      )
      .catch(() => {});
  }
  return reason;
}

/**
 * Drain the queue.
 *
 * `apply: false` decides and reports without writing anything — what the plan
 * runs look like, and what a test can call.
 */
export async function runWriteBackTick(opts: { apply: boolean; limit?: number } = { apply: true }): Promise<TickSummary> {
  const empty: TickSummary = { ok: true, claimed: 0, written: 0, nothing: 0, held: 0, failed: 0, outcomes: [] };

  if (!isSalesforceConfigured()) {
    // Not an error, and deliberately not a failed attempt against any entry:
    // with no Salesforce connection there is nothing to try. Everything stays
    // pending and the next tick that CAN talk to the org does the work.
    return { ...empty, skipped: "Salesforce is not configured" };
  }

  /*
   * 🔴 A PLAN RUN MUST NOT CLAIM. `claimPending` stamps `claimed_at`
   * unconditionally, and every release is behind `if (ctx.apply)` — so a dry
   * run used to strand up to ten entries for CLAIM_STALE_MS (ten minutes),
   * delaying real syncs, and a second dry run would then report an EMPTY queue
   * while ten things were waiting. A preview that changes what it previews is
   * not a preview.
   */
  const limit = opts.limit ?? PER_TICK;
  /*
   * A plan run takes the whole list at once — it changes nothing, so there is
   * nothing to strand. An apply run claims ONE AT A TIME, below.
   */
  const planned = opts.apply ? null : await peekPending(limit);
  if (planned && planned.length === 0) return empty;

  const conn = await getSalesforceClient();
  const ctx = { conn, actorUserId: null, apply: opts.apply };

  /*
   * The candidate list and the review decisions cost one expensive Salesforce
   * round trip (43 open estimates, paged), and a tick with five sales in it
   * must not pay for it five times. Loaded LAZILY now rather than up front:
   * with entries claimed one at a time we no longer know in advance whether
   * this tick contains a sale, and a tick carrying only change orders must not
   * spend that call on candidates it will never look at.
   */
  let candidates: SfCandidate[] | null = null;
  let resolved: Map<string, { decision: string }> | null = null;
  const pairingContext = async () => {
    if (!candidates || !resolved) {
      [candidates, resolved] = await Promise.all([
        listOpenSalesforceCandidates(),
        listResolvedDeals() as Promise<Map<string, { decision: string }>>,
      ]);
    }
    return { candidates, resolved };
  };

  const out: TickSummary = { ...empty, outcomes: [] };

  for (let i = 0; i < limit; i++) {
    /*
     * 🔴 ONE CLAIM AT A TIME.
     *
     * This used to claim all ten up front. Each entry costs ten to twenty
     * seconds — a six-second wait for Salesforce's rollups plus several SOQL
     * round trips — so a full batch can run to 200s against a `maxDuration` of
     * 300. A tick killed at entry four left entries five to ten claimed and
     * untouchable for CLAIM_STALE_MS, dropping throughput from ten a minute to
     * four per ten minutes exactly when the queue is deepest.
     *
     * Claiming one at a time costs one extra round trip per entry, against
     * entries that already take seconds, and means a death mid-tick strands at
     * most one.
     */
    /*
     * 🔴 THE READ INSTANT, TAKEN BEFORE ANYTHING IS READ.
     *
     * This is what gets stamped into `done_at` (see `completionStamp`), not
     * the moment the entry finishes. Everything below reads the deal, the
     * change order and Salesforce AFTER this line, so an edit made here in the
     * Command Center during the ten to twenty seconds the entry takes sorts
     * after this timestamp and the nightly sweep re-queues it. Stamping the
     * finish instead silently swallowed that edit: it was written with an
     * `updated_at` below the `done_at`, and `needsRequeue` only looks for
     * `updated_at > done_at`.
     *
     * Taken before the claim's own round trip, and deliberately a lower bound
     * rather than the exact instant of each individual read: being early can
     * only cause a redundant re-sync, which is idempotent and cheap. Being
     * late loses the edit.
     */
    const readAt = new Date().toISOString();
    const entry = opts.apply ? (await claimPending(1))[0] : planned?.[i];
    if (!entry) break;
    out.claimed++;
    try {
      let o: TickOutcome;
      if (entry.kind === "change_order") {
        o = await runChangeOrder(ctx, entry, readAt);
      } else {
        const { candidates: c, resolved: r } = await pairingContext();
        o = await runSale(ctx, entry, c, r, readAt);
      }
      out.outcomes.push(o);
      if (o.result === "written") out.written++;
      else if (o.result === "nothing") out.nothing++;
      else if (o.result === "held") out.held++;
      else out.failed++;
    } catch (err) {
      /*
       * One entry that throws must not stop the others — that is the whole
       * reason this loop catches per entry rather than around itself. A thrown
       * error IS an attempt, so it counts against the budget.
       */
      const message = err instanceof Error ? err.message : String(err);
      if (opts.apply) {
        try {
          await markFailed(entry.id, entry.attempts, message);
        } catch (markErr) {
          console.warn(`[tomco-tick] ${markErr instanceof Error ? markErr.message : String(markErr)}`);
        }
      }
      out.outcomes.push({ entryId: entry.id, kind: entry.kind, label: entry.opportunityId, result: "failed", detail: message });
      out.failed++;
    }
  }
  out.ok = out.failed === 0;
  return out;
}

async function runChangeOrder(
  ctx: { conn: Awaited<ReturnType<typeof getSalesforceClient>>; actorUserId: string | null; apply: boolean },
  entry: QueueEntry,
  readAt: string,
): Promise<TickOutcome> {
  if (!entry.changeOrderId) {
    // A change_order entry with no change order is a bug in whatever queued it,
    // not something to retry nine hundred times.
    if (ctx.apply) await markDone(entry.id, "no change order id on the queue entry", { readAt });
    return { entryId: entry.id, kind: entry.kind, label: "?", result: "nothing", detail: "no change order id on the queue entry" };
  }
  const r = await syncChangeOrder(ctx, entry.changeOrderId);
  const base = { entryId: entry.id, kind: entry.kind, label: r.label };
  const failedChecks = r.checks.filter((c) => !c.ok);

  if (r.action === "failed") {
    /*
     * If anything was WRITTEN before it failed, the evidence has to outlive the
     * attempt. Otherwise the next tick finds Salesforce already in its new
     * state, returns "nothing to do", and `markDone` clears `last_error` —
     * laundering a half-finished write into a green row. `markVerifyFailed`
     * used to fire only for a failed read-back, never for a failed ACTION.
     */
    if (ctx.apply) {
      if (r.steps.length > 0) await markVerifyFailed(entry.id, `${r.error ?? r.why} (after: ${r.steps.join(" · ")})`);
      await markFailed(entry.id, entry.attempts, r.error ?? r.why);
    }
    return { ...base, result: "failed", detail: r.error ?? r.why };
  }
  if (r.action === "held") {
    const why = await holdEntry(ctx, entry, r.label, r.why, r.waitsFor ?? "person");
    return { ...base, result: "held", detail: why };
  }
  if (failedChecks.length > 0) {
    /*
     * IT WROTE, AND THE READ-BACK DISAGREES.
     *
     * Recorded in `verify_failed_at` as well as failing the attempt, and the
     * two are not the same thing. The attempt is spent and will be retried; the
     * failed VERIFICATION has to outlive that, because an hour later the retry
     * finds Salesforce already in its new state, says "nothing to do", and
     * marks the entry done. Without a separate mark, `markDone` cleared
     * `last_error` and the entry went green — which is exactly how a sale
     * sitting at $0 in Katie's reports read as a clean sync.
     */
    const detail = `wrote it, but: ${failedChecks.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
    if (ctx.apply) {
      await markVerifyFailed(entry.id, detail);
      await markFailed(entry.id, entry.attempts, detail);
    }
    return { ...base, result: "failed", detail };
  }
  /*
   * `verified` only when a read-back actually ran AND passed. An action of
   * "nothing" produces no checks, so it clears nothing — a previously failed
   * verification stays on the record for a person to see.
   */
  if (ctx.apply) await markDone(entry.id, `${r.action}: ${r.why}`, { verified: r.checks.length > 0, readAt });
  return { ...base, result: r.action === "nothing" ? "nothing" : "written", detail: r.why };
}

async function runSale(
  ctx: { conn: Awaited<ReturnType<typeof getSalesforceClient>>; actorUserId: string | null; apply: boolean },
  entry: QueueEntry,
  candidates: SfCandidate[],
  resolved: Map<string, { decision: string }>,
  readAt: string,
): Promise<TickOutcome> {
  const loaded = await loadSoldDeal(entry.opportunityId);
  if (!loaded) {
    /*
     * 🔴 DELETED HERE IS NOT "NOTHING TO DO" WHEN SALESFORCE HAS THE SALE (F24).
     *
     * This marked the entry done — "the deal was deleted here" — and that was
     * the last anyone heard of it. The Salesforce opportunity stayed Closed Won
     * in Katie's total, its change orders stayed Approved, and nothing on
     * either side said the job had gone. Deleting or reversing a sale in
     * Tomco's org is not a decision the sync makes unattended (the same rule as
     * a sale reversed here, below), so it is HELD for a person, who is told.
     * Nothing is written to Salesforce on this path, ever.
     */
    const link = await pairedLinkFor(entry.opportunityId);
    if (!link) {
      if (ctx.apply) await markDone(entry.id, "the deal was deleted here, and Salesforce never had it", { readAt });
      return { entryId: entry.id, kind: entry.kind, label: entry.opportunityId, result: "nothing", detail: "the deal was deleted here, and Salesforce never had it" };
    }
    const why =
      `This deal was deleted here, but Salesforce still holds it (${link.sfId}). The sync never deletes or reverses ` +
      `a sale in Tomco's org on its own — somebody decides what should happen to it there. Restoring the deal here releases this.`;
    const detail = await holdEntry(ctx, entry, `deleted deal ${entry.opportunityId.slice(0, 8)}`, why, "person");
    return { entryId: entry.id, kind: entry.kind, label: entry.opportunityId, result: "held", detail };
  }
  const base = { entryId: entry.id, kind: entry.kind, label: loaded.deal.title };

  if (!loaded.sold) {
    /*
     * NOT SOLD ANY MORE. Two different situations, and telling them apart is
     * the whole point.
     *
     * If Salesforce never had it, there is nothing to do: the queue fires on
     * every status change into a sold state, so a deal moved in and straight
     * back out leaves an entry describing a sale that never reached anybody.
     * Writing it would put a Closed Won in Salesforce for a job this platform
     * says was not sold.
     *
     * If Salesforce DOES have it, that is a Closed Won opportunity over there
     * for a sale this platform has reversed — and un-winning a record in
     * another company's org, with its own validation rules on close dates and
     * stages, is not a decision this system makes unattended. HELD, with the
     * figures named, so a person does it deliberately.
     */
    const link = await pairedLinkFor(entry.opportunityId);
    if (!link) {
      if (ctx.apply) await markDone(entry.id, "no longer a sold deal here, and Salesforce never had it", { readAt });
      return { ...base, result: "nothing", detail: "no longer a sold deal here, and Salesforce never had it" };
    }
    const why =
      `This deal is no longer sold here, but Salesforce still holds it as a sale (${link.sfId}). ` +
      `Reversing a Closed Won opportunity in Tomco's org is not something the sync will do on its own — ` +
      `somebody has to decide what should happen to it over there.`;
    const detail = await holdEntry(ctx, entry, base.label, why, "person");
    return { ...base, result: "held", detail };
  }

  const link = await pairedLinkFor(entry.opportunityId);
  const pairedSfId = link?.sfId ?? null;
  const plan = decideWriteBack({
    deal: loaded.deal,
    pairedSfId,
    openCandidates: candidates,
    dealCreatedAt: loaded.createdAt,
  });

  if (plan.action === "hold") {
    /*
     * A person decides. `markHeld` does not count an attempt, so this waits in
     * the review queue rather than running out of retries while it waits —
     * unless somebody has already cleared it as new, which is the one thing
     * that turns a hold into an insert.
     */
    if (resolved.get(loaded.deal.id)?.decision !== "new") {
      // The pairing screen's two answers call `releaseHold`, which un-parks it.
      const detail = await holdEntry(ctx, entry, base.label, plan.why, "person");
      return { ...base, result: "held", detail };
    }
  }

  if (plan.action === "update") {
    const r = await updateExisting(ctx, loaded.deal, plan.sfId, {
      builtByWriteBack: String(link?.notes ?? "").startsWith(CREATED_LINK_NOTE),
    });
    return finishDeal(ctx, entry, base, r, readAt);
  }

  /*
   * INSERT. The account has to exist in Salesforce first — this never creates
   * one, because two GCs cannot be given the same name by accident here and
   * then merged by hand over there.
   */
  let accountId: string | null = null;
  if (loaded.deal.accountName) {
    const safe = soqlString(loaded.deal.accountName);
    // SOQL `=` is case-insensitive, which is what makes "Cummins Sales" and
    // "Cummins sales" one company.
    const r = await ctx.conn.query(`SELECT Id, Name FROM Account WHERE Name = '${safe}'`);
    if (r.records.length === 1) accountId = r.records[0].Id as string;
    else {
      const why =
        r.records.length > 1
          ? `${r.records.length} Salesforce accounts are named "${loaded.deal.accountName}" — a person has to say which`
          : `no Salesforce account named "${loaded.deal.accountName}" — it has to exist there first; re-check it here once it does`;
      const detail = await holdEntry(ctx, entry, base.label, why, "person");
      return { ...base, result: "held", detail };
    }
  }

  /*
   * The close date. Katie, 2026-10-14: "if the sync happens regularly, then the
   * Close Date should match the date that it's created." Sent because the field
   * is REQUIRED on insert (`nillable=0, defaultedOnCreate=0`), not because it
   * survives — a flow overwrites it with today on the transition to Closed Won.
   */
  const closeDate = (loaded.deal.decidedAt ?? new Date().toISOString()).slice(0, 10);
  const r = await createNew(ctx, loaded.deal, { accountId, closeDate });
  return finishDeal(ctx, entry, base, r, readAt);
}

/**
 * Should the sweep queue this thing again?
 *
 * PURE, and separate from the queries, because each of the three answers is
 * wrong in a different and quiet way:
 *
 *  - Re-queueing something that is STILL PENDING would have the sweep and the
 *    tick fight over the same write every night. (The partial unique index
 *    would refuse it, so the damage is noise rather than a double write — but a
 *    nightly log full of refused inserts is how a real one gets missed.)
 *  - NEVER re-queueing after a successful write would make one write final: a
 *    contract corrected a week later would stay wrong in Salesforce forever,
 *    with both systems reporting success.
 *  - Not queueing something with NO entry at all would miss every sale that
 *    closed before this feature existed, and every one whose hook silently did
 *    not fire — which `queueForWriteBack` is explicitly allowed to do, because
 *    a sale must never fail over a bookkeeping row.
 */
export function needsRequeue(
  latestEntry: { doneAt: string | null } | null,
  updatedAt: string | null,
): boolean {
  if (!latestEntry) return true;
  // Still pending: the tick owns it, and it will be decided within the minute.
  if (!latestEntry.doneAt) return false;
  /*
   * Finished — so only if the thing has changed here since.
   *
   * 🔴 "SINCE" MEANS SINCE THE ENTRY READ IT, NOT SINCE IT STOPPED WRITING.
   * `done_at` carries the read instant, stamped by `completionStamp` from the
   * `readAt` the tick took before it looked at anything. The two are ten to
   * twenty seconds apart — Salesforce round trips plus the six-second wait for
   * the rollups — and an edit landing in that gap is written with an
   * `updated_at` below the completion time, so comparing against the
   * completion time left it invisible to this function for ever. Nothing else
   * sweeps it; the figure in Salesforce would simply stay wrong.
   *
   * PARSED, not string-compared. `updated_at` comes from PostgREST with
   * microsecond precision and a "+00:00" offset; `done_at` is a JS
   * `toISOString()`, millisecond precision ending "Z". Compared as text,
   * "…:00.123456+00:00" sorts BEFORE "…:00.123Z" because '4' < 'Z' — so an
   * edit made in the same second an entry finished would never be swept.
   */
  if (!updatedAt) return false;
  const changed = Date.parse(updatedAt);
  const finished = Date.parse(latestEntry.doneAt);
  if (!Number.isFinite(changed) || !Number.isFinite(finished)) return false;
  return changed > finished;
}

export type SweepSummary = {
  ok: boolean;
  queuedSales: number;
  queuedChangeOrders: number;
  errors: string[];
};

/**
 * The nightly backstop: anything the moment-of-change hook did not catch.
 *
 * WHY THIS EXISTS AT ALL, when the hooks fire on every status change and every
 * change-order decision: because the hooks are best-effort by design.
 * `queueForWriteBack` never throws — a sale must not fail because a bookkeeping
 * row could not be written — and "never throws" means "can silently not
 * happen". It also covers the sales that closed before this feature existed,
 * every entry that ran out of retries, and anything that happened while the
 * database was refusing writes.
 *
 * THE RULE: a sold deal, or an approved change order, is queued when it has no
 * queue entry at all, or when it has changed here since the last entry
 * finished. The second half is what makes a later edit reach Salesforce —
 * without it, one successful write would mark the thing done forever.
 *
 * It only ENQUEUES. The per-minute tick does the writing, so this stays cheap
 * enough to live inside the daily cron alongside the reminders, and the
 * decision that holds a possible duplicate for a person still runs exactly once
 * per entry.
 */
export async function sweepForMissedWriteBacks(): Promise<SweepSummary> {
  const out: SweepSummary = { ok: true, queuedSales: 0, queuedChangeOrders: 0, errors: [] };
  const sb = admin();
  const { queueForWriteBack } = await import("@/lib/salesforce/tomco-queue");

  /*
   * The latest entry per thing. Read once; `commercial_tomco_writeback_queue`
   * holds one row per write, so this is small and stays small.
   */
  const latestSale = new Map<string, string | null>();
  const latestCo = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_tomco_writeback_queue")
      .select("kind, opportunity_id, change_order_id, done_at, queued_at")
      .order("queued_at", { ascending: true })
      .range(from, from + 999);
    if (error) {
      // The migration is applied by hand; until it is, there is nothing to
      // sweep and nothing wrong. See `isMissingQueueTable`.
      const { isQueueNotReady } = await import("@/lib/salesforce/tomco-queue");
      if (isQueueNotReady(error.message)) {
        return { ...out, errors: ["the write-back queue table does not exist yet — migration not applied"] };
      }
      out.errors.push(`queue: ${error.message}`);
      return { ...out, ok: false };
    }
    for (const r of data ?? []) {
      const row = r as { kind: string; opportunity_id: string; change_order_id: string | null; done_at: string | null };
      // Ordered oldest first, so the last write wins and this ends up holding
      // the newest entry's `done_at` — null while one is still pending, which
      // is what keeps the sweep from queueing a second copy of it.
      if (row.kind === "change_order") {
        if (row.change_order_id) latestCo.set(row.change_order_id, row.done_at);
      } else {
        latestSale.set(row.opportunity_id, row.done_at);
      }
    }
    if ((data ?? []).length < 1000) break;
  }

  const needs = (seen: Map<string, string | null>, id: string, updatedAt: string | null): boolean =>
    needsRequeue(seen.has(id) ? { doneAt: seen.get(id) ?? null } : null, updatedAt);

  // ── sold deals ───────────────────────────────────────────────────────────
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_opportunities")
      .select("id, status, sub_status, updated_at, deleted_at")
      .is("deleted_at", null)
      .order("id")
      .range(from, from + 999);
    if (error) {
      out.errors.push(`deals: ${error.message}`);
      out.ok = false;
      break;
    }
    for (const r of data ?? []) {
      const d = r as { id: string; status: string | null; sub_status: string | null; updated_at: string | null };
      if (!isSoldStatus(d.status, d.sub_status)) continue;
      if (!needs(latestSale, d.id, d.updated_at)) continue;
      const q = await queueForWriteBack({ kind: "sale", opportunityId: d.id, actingUserId: null });
      if (q.ok && !q.already) out.queuedSales++;
    }
    if ((data ?? []).length < 1000) break;
  }

  /*
   * ── deleted deals Salesforce still holds (F24) ───────────────────────────
   *
   * The deal-delete hook queues these, but it is best-effort like every hook
   * here, and the loop above reads `deleted_at IS NULL` only. So a deletion
   * whose queue insert failed would leave a live Closed Won sale in Tomco's
   * org with nothing here that ever looks at it again. Queued so the tick can
   * HOLD it for a person — the tick never writes to Salesforce on that path.
   */
  {
    const linkedDealIds = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("commercial_import_map")
        .select("row_id")
        .eq("entity", "deal")
        .order("sf_id")
        .range(from, from + 999);
      if (error) {
        out.errors.push(`deal links: ${error.message}`);
        out.ok = false;
        break;
      }
      for (const r of data ?? []) linkedDealIds.add((r as { row_id: string }).row_id);
      if ((data ?? []).length < 1000) break;
    }
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from("commercial_opportunities")
        .select("id, deleted_at")
        .not("deleted_at", "is", null)
        .order("id")
        .range(from, from + 999);
      if (error) {
        out.errors.push(`deleted deals: ${error.message}`);
        out.ok = false;
        break;
      }
      for (const r of data ?? []) {
        const d = r as { id: string; deleted_at: string };
        if (!linkedDealIds.has(d.id)) continue;
        if (!needs(latestSale, d.id, d.deleted_at)) continue;
        const q = await queueForWriteBack({ kind: "sale", opportunityId: d.id, actingUserId: null });
        if (q.ok && !q.already) out.queuedSales++;
      }
      if ((data ?? []).length < 1000) break;
    }
  }

  /*
   * ── change orders ──────────────────────────────────────────────────────
   *
   * 🔴 NOT JUST THE APPROVED ONES.
   *
   * This asked only for `deleted_at IS NULL AND status = 'approved'`, so a
   * REVERSAL could never be swept up — a declined or deleted change order is
   * outside that set by definition. Its single chance was the call at the
   * moment of the decision, and that call is documented to return `{ok:false}`
   * rather than throw, with both call sites discarding the result. So a queue
   * insert that failed on a decline left money approved in Salesforce that this
   * platform says is not owed, with nothing anywhere that would ever notice.
   *
   * The rule that covers both directions: anything LINKED to a Salesforce
   * change order is something Salesforce may still be counting, whatever its
   * state here. So linked rows are swept regardless of status or deletion, and
   * `syncChangeOrder` decides what Salesforce should hold.
   */
  const linkedRowIds = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_import_map")
      .select("row_id")
      .eq("entity", CO_MAP_ENTITY)
      .order("sf_id")
      .range(from, from + 999);
    if (error) {
      out.errors.push(`change-order links: ${error.message}`);
      out.ok = false;
      break;
    }
    for (const r of data ?? []) linkedRowIds.add((r as { row_id: string }).row_id);
    if ((data ?? []).length < 1000) break;
  }

  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_change_orders")
      // No status or deleted filter: the filtering happens below, so a reversal
      // is visible to this sweep.
      .select("id, opportunity_id, status, title, updated_at, deleted_at")
      .order("id")
      .range(from, from + 999);
    if (error) {
      out.errors.push(`change orders: ${error.message}`);
      out.ok = false;
      break;
    }
    for (const r of data ?? []) {
      const c = r as {
        id: string;
        opportunity_id: string;
        status: string;
        title: string | null;
        updated_at: string | null;
        deleted_at: string | null;
      };
      // The migrated rollup rows are never pushed — see ROLLUP_TITLE. Filtered
      // here as well as inside `syncChangeOrder` so the sweep does not queue 18
      // entries a night that exist only to decide to do nothing.
      if (ROLLUP_TITLE.test(String(c.title ?? ""))) continue;
      /*
       * Worth a look if EITHER Salesforce should be counting it (approved and
       * live here) OR Salesforce may still be counting it (linked, whatever it
       * is here now). Everything else — a pending change order nobody has
       * decided, a declined one that was never pushed — has nothing to sync.
       */
      const shouldCount = !c.deleted_at && c.status === "approved";
      const salesforceMayHoldIt = linkedRowIds.has(c.id);
      if (!shouldCount && !salesforceMayHoldIt) continue;
      if (!needs(latestCo, c.id, c.updated_at)) continue;
      const q = await queueForWriteBack({
        kind: "change_order",
        opportunityId: c.opportunity_id,
        changeOrderId: c.id,
        actingUserId: null,
      });
      if (q.ok && !q.already) out.queuedChangeOrders++;
    }
    if ((data ?? []).length < 1000) break;
  }

  return out;
}

/** Mark the queue entry from a write-back outcome, read-back checks included. */
async function finishDeal(
  ctx: { apply: boolean },
  entry: QueueEntry,
  base: { entryId: string; kind: QueueEntry["kind"]; label: string },
  r: { action: string; error?: string; checks: Array<{ name: string; ok: boolean; detail: string }>; steps: string[] },
  readAt: string,
): Promise<TickOutcome> {
  if (r.action === "held") {
    const detail = await holdEntry(ctx, entry, base.label, r.error ?? "a person has to look", "person");
    return { ...base, result: "held", detail };
  }
  if (r.action === "failed") {
    // Same as the change-order branch: a failure that already wrote something
    // leaves a mark the next tick's "skipped" cannot wipe.
    if (ctx.apply) {
      if (r.steps.length > 0) await markVerifyFailed(entry.id, `${r.error ?? "failed"} (after: ${r.steps.join(" · ")})`);
      await markFailed(entry.id, entry.attempts, r.error ?? "failed");
    }
    return { ...base, result: "failed", detail: r.error ?? "failed" };
  }
  const failedChecks = r.checks.filter((c) => !c.ok);
  if (failedChecks.length > 0) {
    // See the change-order branch: the failed verification outlives the attempt.
    // "wrote it, but" is a lie on the skip path, which explicitly writes
    // nothing — and a skip is the state every successfully written deal
    // settles into, so it is the message a person reads most often.
    const did = r.action === "skipped" ? "left it alone, but" : "wrote it, but";
    const detail = `${did}: ${failedChecks.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
    if (ctx.apply) {
      await markVerifyFailed(entry.id, detail);
      await markFailed(entry.id, entry.attempts, detail);
    }
    return { ...base, result: "failed", detail };
  }
  const detail = r.steps.length ? r.steps.join(" · ") : r.action;
  if (ctx.apply) {
    await markDone(entry.id, `${r.action}: ${detail}`.slice(0, 2000), { verified: r.checks.length > 0, readAt });
    // The sale is in: anything waiting on it can go now, not in an hour.
    await nudgeChangeOrdersWaitingOnSale(entry.opportunityId);
  }
  /*
   * `skipped` is what `updateExisting` returns for a deal Salesforce already
   * has as Closed Won at the right value — the 93-of-94 case. Finished, and
   * NOT counted as a write: a summary that calls 93 skips 93 writes is the one
   * that reported "21 would be written" when the answer was three.
   */
  // `adopted` re-linked a record Salesforce already had — a local write only.
  return { ...base, result: r.action === "skipped" || r.action === "adopted" ? "nothing" : "written", detail };
}
