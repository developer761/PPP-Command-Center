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

async function loadHeld(): Promise<HeldLead[]> {
  const sb = messagingDb();
  const { data, error } = await sb
    .from("sf_lead_inbound")
    .select("id, status, triage_reason, sf_created_at, received_at")
    .in("status", ["triage", "ignored", "failed"])
    .order("received_at", { ascending: false })
    .limit(SCAN_LIMIT);
  // Throws rather than returning none: "nothing is held" is a claim, and a
  // failed query must not be able to make it.
  if (error) throw new Error(`could not read held leads: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    status: r.status as string,
    triageReason: (r.triage_reason as string | null) ?? null,
    sfCreatedAt: (r.sf_created_at as string | null) ?? null,
    receivedAt: (r.received_at as string | null) ?? null,
  }));
}

export type HeldSummary = {
  /** Every held lead, however old. */
  total: number;
  /** How many a release would actually move, at this window. */
  releasable: number;
  maxAgeHours: number;
  /** Why the rest are staying put, counted. */
  holding: { why: string; count: number; oldestDays?: number }[];
};

/** What is held, and what a release would do. Reads only. */
export async function heldLeads(maxAgeHours = DEFAULT_MAX_AGE_HOURS): Promise<HeldSummary> {
  await assertMessagingAccess();
  const leads = await loadHeld();
  const plan = planRedrive(leads, { now: new Date(), maxAgeHours });
  return {
    total: leads.length,
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
  const leads = await loadHeld();
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
    .in("status", ["triage", "ignored", "failed"]);

  if (error) return { ok: false, error: `Could not release them: ${error.message}` };
  return { ok: true, released: release.length };
}
