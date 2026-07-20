import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Bid-lifecycle helpers — Katie 2026-07-20 asks the platform to track
 * four canonical dates on every opportunity and derive two durations:
 *
 *   RFP Received      → opp.rfp_received_at         (migration 069)
 *   Proposal Submitted → MIN(proposals.sent_at)     (queried live)
 *   Due Date          → opp.proposal_due_at         (existing)
 *   Close Date        → opp.decided_at              (existing)
 *
 *   Time to proposal  = Proposal Submitted − RFP Received
 *   Time to sale      = Close Date − Proposal Submitted
 *
 * These live in ONE place so the deal detail hero, the account Deals
 * tab, and any future analytics view display the same values.
 */

export type OpportunityLifecycleDates = {
  rfp_received_at: string | null;
  proposal_submitted_at: string | null;
  proposal_due_at: string | null;
  decided_at: string | null;
  /** Days between RFP received and first Sent proposal. Null when
   *  either endpoint is missing OR when the proposal predates the RFP
   *  (data-entry drift — surface as "—" instead of a negative number). */
  time_to_proposal_days: number | null;
  /** Days between first Sent proposal and Close (won/lost) date. Null
   *  when either endpoint is missing OR when close predates proposal. */
  time_to_sale_days: number | null;
};

/** Fetch the first-sent-proposal timestamp for one opportunity. NULL
 *  when the opp has no sent proposal (all drafts, no proposals at
 *  all, or every revision still in draft). Uses `sent_at` — MIN across
 *  revisions so R1's send is the canonical "proposal went out" moment
 *  even after R2 supersedes it. */
export async function fetchProposalSubmittedAt(
  opportunityId: string
): Promise<string | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposals")
    .select("sent_at")
    .eq("opportunity_id", opportunityId)
    .is("deleted_at", null)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { sent_at?: string | null } | null)?.sent_at ?? null;
}

/** Compute the full lifecycle strip for one opp. Fires the proposal
 *  query internally so callers don't have to juggle it. Returns an
 *  object with the raw dates + the two derived durations. */
export async function fetchOpportunityLifecycle(opp: {
  id: string;
  rfp_received_at: string | null;
  proposal_due_at: string | null;
  decided_at: string | null;
}): Promise<OpportunityLifecycleDates> {
  const proposalSubmittedAt = await fetchProposalSubmittedAt(opp.id);
  return computeLifecycle({
    rfp_received_at: opp.rfp_received_at,
    proposal_submitted_at: proposalSubmittedAt,
    proposal_due_at: opp.proposal_due_at,
    decided_at: opp.decided_at,
  });
}

/** Pure helper — takes raw dates, returns dates + durations. Kept
 *  separate so unit tests / preview UIs can compute without hitting the
 *  database. */
export function computeLifecycle(input: {
  rfp_received_at: string | null;
  proposal_submitted_at: string | null;
  proposal_due_at: string | null;
  decided_at: string | null;
}): OpportunityLifecycleDates {
  const timeToProposal = safeDayDiff(input.rfp_received_at, input.proposal_submitted_at);
  const timeToSale = safeDayDiff(input.proposal_submitted_at, input.decided_at);
  return {
    ...input,
    time_to_proposal_days: timeToProposal,
    time_to_sale_days: timeToSale,
  };
}

/** Days between two ISO timestamps. Returns null on either side
 *  missing, unparseable, or when the second is before the first
 *  (bad data — display "—" instead of a negative duration). */
function safeDayDiff(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.floor((b - a) / 86_400_000);
  return diff >= 0 ? diff : null;
}

/** Human-friendly duration: "same day", "1 day", "12 days", "3 weeks",
 *  "4 months", "1 year". Null → "—". Rounding is user-friendly, not
 *  precise. */
export function formatDurationDays(days: number | null): string {
  if (days === null || days === undefined) return "—";
  if (days === 0) return "same day";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? "" : "s"}`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} year${years === 1 ? "" : "s"}`;
}
