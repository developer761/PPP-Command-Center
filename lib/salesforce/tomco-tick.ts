import "server-only";

import { getSalesforceClient, isSalesforceConfigured } from "@/lib/salesforce/client";
import { claimPending, markDone, markFailed, markHeld, type QueueEntry } from "@/lib/salesforce/tomco-queue";
import { decideWriteBack } from "@/lib/salesforce/tomco-decide";
import {
  isSoldStatus,
  listOpenSalesforceCandidates,
  listResolvedDeals,
  loadSoldDeal,
  type SfCandidate,
} from "@/lib/salesforce/tomco-pairing";
import { createNew, updateExisting } from "@/lib/salesforce/tomco-writeback";
import { ROLLUP_TITLE, syncChangeOrder } from "@/lib/salesforce/tomco-changeorder";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

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
 *  2. RETRIES ARE BOUNDED. Three attempts (`MAX_ATTEMPTS`), then the entry
 *     stops asking and `last_error` says why. A validation rule does not fix
 *     itself, and an entry retried every minute forever buries the real
 *     failures in the Slack channel.
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

/** The Salesforce opportunity this deal is linked to, if any. */
async function pairedSfIdFor(opportunityId: string): Promise<string | null> {
  const { data } = await admin()
    .from("commercial_import_map")
    .select("sf_id")
    .eq("entity", "deal")
    .eq("row_id", opportunityId)
    .maybeSingle();
  return (data as { sf_id?: string } | null)?.sf_id ?? null;
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

  const pending = await claimPending(opts.limit ?? PER_TICK);
  if (pending.length === 0) return empty;

  const conn = await getSalesforceClient();
  const ctx = { conn, actorUserId: null, apply: opts.apply };

  /*
   * The candidate list and the review decisions are read ONCE for the tick,
   * not per entry. The candidate query is the expensive part (43 open
   * estimates, paged), and a tick with five sales in it would otherwise make
   * the same call five times for the same answer.
   *
   * Only when there is a sale to decide. A tick carrying nothing but change
   * orders must not spend a Salesforce round trip on pairing candidates it
   * will never look at.
   */
  const hasSale = pending.some((e) => e.kind === "sale");
  let candidates: SfCandidate[] = [];
  let resolved = new Map<string, { decision: string }>();
  if (hasSale) {
    [candidates, resolved] = await Promise.all([
      listOpenSalesforceCandidates(),
      listResolvedDeals() as Promise<Map<string, { decision: string }>>,
    ]);
  }

  const out: TickSummary = { ...empty, claimed: pending.length, outcomes: [] };

  for (const entry of pending) {
    try {
      const o =
        entry.kind === "change_order"
          ? await runChangeOrder(ctx, entry)
          : await runSale(ctx, entry, candidates, resolved);
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
      if (opts.apply) await markFailed(entry.id, entry.attempts, message);
      out.outcomes.push({ entryId: entry.id, kind: entry.kind, label: entry.opportunityId, result: "failed", detail: message });
      out.failed++;
    }
  }
  return out;
}

async function runChangeOrder(
  ctx: { conn: Awaited<ReturnType<typeof getSalesforceClient>>; actorUserId: string | null; apply: boolean },
  entry: QueueEntry,
): Promise<TickOutcome> {
  if (!entry.changeOrderId) {
    // A change_order entry with no change order is a bug in whatever queued it,
    // not something to retry nine hundred times.
    if (ctx.apply) await markDone(entry.id, "no change order id on the queue entry");
    return { entryId: entry.id, kind: entry.kind, label: "?", result: "nothing", detail: "no change order id on the queue entry" };
  }
  const r = await syncChangeOrder(ctx, entry.changeOrderId);
  const base = { entryId: entry.id, kind: entry.kind, label: r.label };
  const failedChecks = r.checks.filter((c) => !c.ok);

  if (r.action === "failed") {
    if (ctx.apply) await markFailed(entry.id, entry.attempts, r.error ?? r.why);
    return { ...base, result: "failed", detail: r.error ?? r.why };
  }
  if (r.action === "held") {
    if (ctx.apply) await markHeld(entry.id, r.why);
    return { ...base, result: "held", detail: r.why };
  }
  if (failedChecks.length > 0) {
    /*
     * IT WROTE, AND THE READ-BACK DISAGREES. Not marked done: the point of
     * reading back is to refuse to believe the write on its own, and marking it
     * finished anyway would make the check decorative.
     */
    const detail = `wrote it, but: ${failedChecks.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
    if (ctx.apply) await markFailed(entry.id, entry.attempts, detail);
    return { ...base, result: "failed", detail };
  }
  if (ctx.apply) await markDone(entry.id, `${r.action}: ${r.why}`);
  return { ...base, result: r.action === "nothing" ? "nothing" : "written", detail: r.why };
}

async function runSale(
  ctx: { conn: Awaited<ReturnType<typeof getSalesforceClient>>; actorUserId: string | null; apply: boolean },
  entry: QueueEntry,
  candidates: SfCandidate[],
  resolved: Map<string, { decision: string }>,
): Promise<TickOutcome> {
  const loaded = await loadSoldDeal(entry.opportunityId);
  if (!loaded) {
    if (ctx.apply) await markDone(entry.id, "the deal was deleted here");
    return { entryId: entry.id, kind: entry.kind, label: entry.opportunityId, result: "nothing", detail: "the deal was deleted here" };
  }
  const base = { entryId: entry.id, kind: entry.kind, label: loaded.deal.title };

  if (!loaded.sold) {
    /*
     * UN-WON BEFORE THE TICK GOT TO IT. Finished, and nothing written: the
     * queue is fired on every status change into a sold state, so a deal moved
     * in and straight back out again leaves an entry describing a sale that no
     * longer exists. Writing it would put a Closed Won in Salesforce for a job
     * this platform says was not sold.
     */
    if (ctx.apply) await markDone(entry.id, "no longer a sold deal here");
    return { ...base, result: "nothing", detail: "no longer a sold deal here" };
  }

  const pairedSfId = await pairedSfIdFor(entry.opportunityId);
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
      if (ctx.apply) await markHeld(entry.id, plan.why);
      return { ...base, result: "held", detail: plan.why };
    }
  }

  if (plan.action === "update") {
    const r = await updateExisting(ctx, loaded.deal, plan.sfId);
    return finishDeal(ctx, entry, base, r);
  }

  /*
   * INSERT. The account has to exist in Salesforce first — this never creates
   * one, because two GCs cannot be given the same name by accident here and
   * then merged by hand over there.
   */
  let accountId: string | null = null;
  if (loaded.deal.accountName) {
    const safe = loaded.deal.accountName.replace(/'/g, "\\'");
    // SOQL `=` is case-insensitive, which is what makes "Cummins Sales" and
    // "Cummins sales" one company.
    const r = await ctx.conn.query(`SELECT Id, Name FROM Account WHERE Name = '${safe}'`);
    if (r.records.length === 1) accountId = r.records[0].Id as string;
    else {
      const why =
        r.records.length > 1
          ? `${r.records.length} Salesforce accounts are named "${loaded.deal.accountName}" — a person has to say which`
          : `no Salesforce account named "${loaded.deal.accountName}" — it has to exist there first`;
      if (ctx.apply) await markHeld(entry.id, why);
      return { ...base, result: "held", detail: why };
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
  return finishDeal(ctx, entry, base, r);
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
  // Finished — so only if the thing has changed here since.
  return !!updatedAt && updatedAt > latestEntry.doneAt;
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
      const { isMissingQueueTable } = await import("@/lib/salesforce/tomco-queue");
      if (isMissingQueueTable(error.message)) {
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

  // ── approved change orders ───────────────────────────────────────────────
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("commercial_change_orders")
      .select("id, opportunity_id, status, title, updated_at, deleted_at")
      .is("deleted_at", null)
      .eq("status", "approved")
      .order("id")
      .range(from, from + 999);
    if (error) {
      out.errors.push(`change orders: ${error.message}`);
      out.ok = false;
      break;
    }
    for (const r of data ?? []) {
      const c = r as { id: string; opportunity_id: string; title: string | null; updated_at: string | null };
      // The migrated rollup rows are never pushed — see ROLLUP_TITLE. Filtered
      // here as well as inside `syncChangeOrder` so the sweep does not queue 18
      // entries a night that exist only to decide to do nothing.
      if (ROLLUP_TITLE.test(String(c.title ?? ""))) continue;
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
): Promise<TickOutcome> {
  if (r.action === "failed") {
    if (ctx.apply) await markFailed(entry.id, entry.attempts, r.error ?? "failed");
    return { ...base, result: "failed", detail: r.error ?? "failed" };
  }
  const failedChecks = r.checks.filter((c) => !c.ok);
  if (failedChecks.length > 0) {
    const detail = `wrote it, but: ${failedChecks.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
    if (ctx.apply) await markFailed(entry.id, entry.attempts, detail);
    return { ...base, result: "failed", detail };
  }
  const detail = r.steps.length ? r.steps.join(" · ") : r.action;
  if (ctx.apply) await markDone(entry.id, `${r.action}: ${detail}`.slice(0, 2000));
  /*
   * `skipped` is what `updateExisting` returns for a deal Salesforce already
   * has as Closed Won at the right value — the 93-of-94 case. Finished, and
   * NOT counted as a write: a summary that calls 93 skips 93 writes is the one
   * that reported "21 would be written" when the answer was three.
   */
  return { ...base, result: r.action === "skipped" ? "nothing" : "written", detail };
}
