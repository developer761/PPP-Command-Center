"use server";

/**
 * Looking at held leads, and letting the fresh ones through.
 *
 * The dead end this closes is in lead-redrive.ts. In short: processPendingLeads
 * reads only 'pending' rows, so every other status is terminal, and a lead held
 * because a region was off or a workflow unpublished stays held after somebody
 * switches that region on.
 *
 * TWO ACTIONS, and the split is deliberate. `heldLeads` only counts, so the
 * screen can say what a release would do BEFORE anybody presses anything.
 * `releaseHeldLeads` is the one that moves rows, and it re-checks every lead
 * itself rather than trusting a list the browser sent back — a stale page
 * offering to release 6 leads must not release 400 because the window moved.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import {
  planRedrive, DEFAULT_MAX_AGE_HOURS, type HeldLead,
} from "./lead-redrive";

/** Rows to consider in one pass. Generous: this counts, it does not send. */
const SCAN_LIMIT = 2000;

/** The statuses that mean a lead is held. One list, so the count and the scan
 *  cannot describe different sets of rows. */
const HELD_STATUSES = ["triage", "ignored", "failed"] as const;

async function loadHeld(): Promise<{ leads: HeldLead[]; total: number }> {
  const sb = messagingDb();
  /**
   * THE COUNT COMES FROM THE DATABASE, NOT FROM THE ROWS WE FETCHED.
   *
   * `total` was `leads.length` against a query capped at SCAN_LIMIT, and the
   * screen renders it as "N leads waiting on something" — a definite claim
   * about the whole backlog. Past 2000 held leads it would have said 2000,
   * for ever, and stopped moving as the backlog grew: work fifty off and it
   * still says 2000, which reads as making no progress at all.
   *
   * The same mistake the board and the review queue each had, and db.ts
   * already explains at length why a capped list must never be shown as a
   * total. Both of those were fixed and this one was missed — the fix landing
   * on one twin.
   *
   * head+count, so the database counts and no rows are read. The filters must
   * stay identical to the scan below, which is why the status list is one
   * constant: a count describing a different set of rows from the list under
   * it is the same lie wearing a more convincing number.
   */
  const { count, error: countErr } = await sb
    .from("sf_lead_inbound")
    .select("id", { count: "exact", head: true })
    .in("status", HELD_STATUSES as unknown as string[]);
  if (countErr) throw new Error(`could not count held leads: ${countErr.message}`);

  const { data, error } = await sb
    .from("sf_lead_inbound")
    .select("id, status, triage_reason, sf_created_at, received_at")
    .in("status", HELD_STATUSES as unknown as string[])
    .order("received_at", { ascending: false })
    .limit(SCAN_LIMIT);
  // Throws rather than returning none: "nothing is held" is a claim, and a
  // failed query must not be able to make it.
  if (error) throw new Error(`could not read held leads: ${error.message}`);

  return {
    total: count ?? 0,
    leads: (data ?? []).map((r) => ({
      id: r.id as string,
      status: r.status as string,
      triageReason: (r.triage_reason as string | null) ?? null,
      sfCreatedAt: (r.sf_created_at as string | null) ?? null,
      receivedAt: (r.received_at as string | null) ?? null,
    })),
  };
}

export type HeldSummary = {
  /** Every held lead, however old — counted by the database, not by the scan. */
  total: number;
  /**
   * How many of them this pass actually looked at, capped at SCAN_LIMIT.
   *
   * Equal to `total` in every normal case. When it is LOWER, `releasable` and
   * `holding` describe only this many rows and the screen has to say so —
   * otherwise it offers to release a number computed from a subset while
   * naming a bigger backlog, which is the worst of both.
   */
  scanned: number;
  /** How many a release would actually move, at this window. */
  releasable: number;
  maxAgeHours: number;
  /** Why the rest are staying put, counted. */
  holding: { why: string; count: number; oldestDays?: number }[];
};

/** What is held, and what a release would do. Reads only. */
export async function heldLeads(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<HeldSummary> {
  await assertMessagingAccess();
  const { leads, total } = await loadHeld();
  const plan = planRedrive(leads, { now: new Date(), maxAgeHours });
  return {
    total,
    scanned: leads.length,
    releasable: plan.release.length,
    maxAgeHours,
    holding: Object.entries(plan.holdReasons)
      .map(([why, count]) => ({ why, count, oldestDays: plan.holdOldestDays[why] }))
      .sort((a, b) => b.count - a.count),
  };
}

export type ReleaseResult = { ok: true; released: number } | { ok: false; error: string };

/**
 * Put the fresh held leads back in the queue.
 *
 * Sets them to 'pending', which is the only status processPendingLeads reads;
 * the next tick picks them up and runs the ordinary intake on them, gate and
 * all. Nothing here sends a message or decides a route — it reopens the
 * question, and the usual path answers it.
 *
 * The age guard is applied HERE, against rows read fresh, not against whatever
 * the browser last saw.
 */
export async function releaseHeldLeads(input: { maxAgeHours?: number } = {}): Promise<ReleaseResult> {
  await assertMessagingAccess();
  const maxAgeHours = input.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;

  // A ceiling on the ceiling. Somebody typing 10000 into a box should not be
  // able to text a year of leads; widening the window is a judgement call,
  // and this is where the judgement stops being reasonable.
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > 24 * 14) {
    return { ok: false, error: "The window has to be between 1 hour and 14 days." };
  }

  const sb = messagingDb();
  // Only the scanned rows are released, which is the same bound the summary
  // now reports: a release moves what this pass could see, and the rest come
  // into range on the next one.
  const { leads } = await loadHeld();
  const { release } = planRedrive(leads, { now: new Date(), maxAgeHours });
  if (!release.length) return { ok: true, released: 0 };

  const { error } = await sb
    .from("sf_lead_inbound")
    .update({
      status: "pending",
      // Cleared so the next attempt's reason is its own rather than the old
      // one lingering next to a row that has since been reconsidered.
      triage_reason: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", release.map((l) => l.id))
    // Belt and braces against a concurrent tick: only move rows that are still
    // held. A row that became 'routed' between the read and the write must not
    // be dragged back to pending and enrolled twice.
    //
    // THE SAME CONSTANT THE COUNT AND THE SCAN USE. This was a third copy of
    // the list, spelled out. Change what "held" means and the summary would
    // count one set of rows while the release moved another — the read saying
    // 1514 and the write touching a different 1514.
    .in("status", HELD_STATUSES as unknown as string[]);

  if (error) return { ok: false, error: `Could not release them: ${error.message}` };
  return { ok: true, released: release.length };
}
