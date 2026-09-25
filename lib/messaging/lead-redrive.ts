/**
 * Letting a held lead through, once the thing that held it is fixed.
 *
 * ── THE DEAD END ────────────────────────────────────────────────────────
 *
 * processPendingLeads only ever reads rows with status 'pending'. Everything
 * else is terminal. So a lead held because a region was not switched on, or a
 * workflow was not active, or a database call blipped, stays held forever —
 * including after somebody fixes exactly that thing. In production on
 * 2026-09-22:
 *
 *   432  ignored — no active workflow covers this workspace
 *    53  triage  — no matching workspace
 *    18  triage  — region not live (CO Denver, CA LA)
 *     3  triage  — no contactable phone
 *
 * The 432 routed correctly and are waiting on a switch nobody has flipped yet.
 * The moment somebody flips it, none of them move.
 *
 * ── WHY THIS IS NOT AUTOMATIC ───────────────────────────────────────────
 *
 * The obvious fix is to re-drive held rows on the tick. That fix texts four
 * hundred people about an enquiry they made last week, the moment a workflow
 * goes live, with nobody having asked for it. Every reason a lead is held
 * resolves through a DELIBERATE act — a region switched on, a number added, a
 * workflow published — so the person doing that act is the person who should
 * decide whether the backlog goes out with it.
 *
 * So: a person asks, and the AGE GUARD below decides what is still reasonable
 * to send. That guard is the feature. Without it this module is a way to spam
 * a month of leads with one click.
 */

/** Statuses that can be reconsidered. 'routed' is done; 'pending' is in hand. */
export type HeldStatus = "triage" | "ignored" | "failed";

export type HeldLead = {
  id: string;
  status: string;
  /** Free text: "region_not_live: CA LA Leads is not switched on yet". */
  triageReason: string | null;
  /** When Salesforce created the lead — the age that matters to a customer. */
  sfCreatedAt: string | null;
  /** When we first saw it. Fallback when Salesforce gave us no date. */
  receivedAt: string | null;
};

export type RedriveDecision =
  | { redrive: true }
  /**
   * `why` is the CATEGORY and nothing else; anything that varies per lead
   * goes in `ageDays`.
   *
   * The age used to be part of the sentence, so 619 leads held for one reason
   * arrived on the screen as ten near-identical rows — 84, 83, 80, 78, 74,
   * 74, 72, 50, 15, 9 — each saying "past the 24h limit" with a different
   * number in front. The one fact worth reading, that almost the whole
   * backlog has a single cause, was the one thing the list could not show.
   */
  | { redrive: false; why: string; ageDays?: number };

/**
 * How old a lead may be and still be worth texting.
 *
 * A day. Somebody who asked for a quote yesterday morning still remembers
 * asking; somebody who asked last Tuesday has either hired a painter or
 * forgotten, and "Thanks for requesting a free estimate!" arriving now reads
 * as incompetence rather than service.
 *
 * Deliberately conservative as a DEFAULT, not a ceiling — releasing a genuine
 * backlog is a decision somebody can make explicitly by passing a wider
 * window, and they will have to type the number to do it.
 */
export const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * Reasons that are worth reconsidering at all.
 *
 * A lead with no phone number will still have no phone number; re-driving it
 * spends a Salesforce round trip to reach the same answer. These are the
 * reasons that resolve when somebody changes something.
 */
const TRANSIENT = [
  "region_not_live",        // a workspace was switched on
  "workspace_has_no_number", // a number was added
  "no_matching_workspace",   // a routing rule was written, or a zip map loaded
  "region_unclear",          // the zip map was empty and is not any more
  "no active workflow",      // a workflow was published
] as const;

/** Reasons that will answer the same way however many times they are asked. */
const PERMANENT = [
  "no_contactable_phone",
  "not_serviced",
  "opted out",
] as const;

export function reasonIsWorthRetrying(reason: string | null): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;
  // Permanent wins on a tie: "not_serviced" must never be re-driven because
  // it happens to contain a word another rule matches.
  if (PERMANENT.some((p) => r.includes(p.toLowerCase()))) return false;
  return TRANSIENT.some((t) => r.includes(t.toLowerCase()));
}

export function ageHours(lead: HeldLead, now: Date): number | null {
  const t = lead.sfCreatedAt ?? lead.receivedAt;
  if (!t) return null;
  const ms = now.getTime() - new Date(t).getTime();
  if (!Number.isFinite(ms)) return null;
  // A lead from the future is clock skew, not a fresh lead. Treated as age 0
  // rather than negative, which would sort oddly and read as nonsense.
  return Math.max(0, ms / 3_600_000);
}

/**
 * Should this held lead be put back in the queue?
 *
 * Every refusal says why, because the counts are what tell somebody whether
 * the backlog is worth releasing at all.
 */
export function shouldRedrive(
  lead: HeldLead,
  opts: { now: Date; maxAgeHours?: number }
): RedriveDecision {
  const maxAge = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;

  if (lead.status === "routed") return { redrive: false, why: "already routed" };
  if (lead.status === "pending") return { redrive: false, why: "already waiting to be processed" };

  // A crash mid-enrolment leaves 'failed' with a raw error rather than one of
  // our reasons. Those ARE worth retrying — the row is the only record that
  // the lead existed.
  if (lead.status !== "failed" && !reasonIsWorthRetrying(lead.triageReason)) {
    return { redrive: false, why: `"${lead.triageReason ?? "no reason recorded"}" will not answer differently` };
  }

  const age = ageHours(lead, opts.now);
  if (age === null) {
    // No date at all. Refused rather than guessed: an undated lead could be
    // from any time, and the whole point of this guard is not to text people
    // about something they have forgotten.
    return { redrive: false, why: "no creation date, so its age cannot be checked" };
  }
  if (age > maxAge) {
    return {
      redrive: false,
      why: `older than the ${maxAge}h limit`,
      ageDays: Math.round(age / 24),
    };
  }

  return { redrive: true };
}

export type RedrivePlan = {
  release: HeldLead[];
  /** Everything not released, and the reason, counted for the screen. */
  holdReasons: Record<string, number>;
  /** The oldest lead behind each reason, so collapsing the rows loses nothing. */
  holdOldestDays: Record<string, number>;
};

/** Split a batch into what goes back in the queue and what stays put. */
export function planRedrive(
  leads: HeldLead[],
  opts: { now: Date; maxAgeHours?: number }
): RedrivePlan {
  const release: HeldLead[] = [];
  const holdReasons: Record<string, number> = {};
  const holdOldestDays: Record<string, number> = {};
  for (const l of leads) {
    const d = shouldRedrive(l, opts);
    if (d.redrive) { release.push(l); continue; }
    holdReasons[d.why] = (holdReasons[d.why] ?? 0) + 1;
    if (d.ageDays !== undefined) {
      holdOldestDays[d.why] = Math.max(holdOldestDays[d.why] ?? 0, d.ageDays);
    }
  }
  return { release, holdReasons, holdOldestDays };
}
