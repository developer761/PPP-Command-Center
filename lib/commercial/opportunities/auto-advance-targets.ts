import { stageRank } from "./constants";

/**
 * The ONLY four states an automatic move may target.
 *
 * A whitelist rather than "any status", because every trigger the adversarial
 * pass killed (§4b) was a plausible-looking one: won → Pre-Construction skips
 * the Win/Loss debrief and never stamps `decided_at`, so the win vanishes from
 * "Wins this month"; first-invoice → Billing marks a 15%-done AIA job as
 * Billing and forward-only never lets it back; a work order crossing a deal
 * pre→post books delivery on a bid nobody recorded as won. None of those can be
 * expressed here, which is the point.
 *
 * `order` is the position used for the forward-only comparison. For the three
 * live stages it IS `stageRank` (asserted below, so the two can't drift). Only
 * `closed` needs its own number: `stageRank` deliberately returns null for it
 * (terminal — never a legal source), but it is a legal TARGET, so it sits above
 * the whole ladder at 8.
 */
export type AutoAdvanceTargetKey = "estimating" | "proposal" | "won" | "closed";

export type AutoAdvanceTarget = {
  status: string;
  sub_status: string;
  order: number;
  /** Goes in the timeline note, so it reads as the stage a person recognises. */
  label: string;
  /**
   * Extra source restriction beyond "ranks below the target".
   * Closeout completion may only close a job that's actually in delivery — the
   * rank guard alone would let it close a deal sitting in Qualifying.
   */
  requiresPostSale?: boolean;
};

export const AUTO_ADVANCE_TARGETS: Record<AutoAdvanceTargetKey, AutoAdvanceTarget> = {
  estimating: { status: "estimating", sub_status: "estimating", order: 1, label: "Estimating" },
  proposal: { status: "proposal", sub_status: "sent", order: 2, label: "Proposal" },
  won: { status: "pre_sale_closed", sub_status: "won", order: 3, label: "Closed Won" },
  closed: {
    status: "post_sale_closed",
    sub_status: "closed",
    order: 8,
    label: "Closed",
    requiresPostSale: true,
  },
};

/**
 * Maps a proposal's status to the stage it justifies — the resulting STATUS,
 * not the word "proposal".
 *
 * A draft/pending/approved proposal targets **Estimating**, not Proposal: a
 * draft is work-in-progress, and advancing to Proposal would fabricate a "sent"
 * deal that has no PDF and no approval, walking straight past the send gate.
 * Returns null for anything that justifies no move (rejected, void, unknown).
 */
export function targetForProposalStatus(status: string | null | undefined): AutoAdvanceTargetKey | null {
  switch (status) {
    case "draft":
    case "pending_approval":
    case "approved":
      return "estimating";
    case "sent":
      return "proposal";
    case "won":
      return "won";
    default:
      return null;
  }
}

/**
 * Folds every trigger fired in one request into the single furthest target.
 *
 * Required by §4d.4: a deal with three proposals must produce ONE write, ONE
 * log row and ONE notification. Applying them in sequence would walk the deal
 * up the ladder one stage at a time and spray the timeline with intermediate
 * stages it was never really in.
 */
export function foldAutoAdvanceTargets(
  keys: Array<AutoAdvanceTargetKey | null | undefined>
): AutoAdvanceTargetKey | null {
  let best: AutoAdvanceTargetKey | null = null;
  for (const k of keys) {
    if (!k) continue;
    if (best === null || AUTO_ADVANCE_TARGETS[k].order > AUTO_ADVANCE_TARGETS[best].order) best = k;
  }
  return best;
}

/**
 * Would an automatic move to `key` actually go forwards from this state?
 *
 * The in-process mirror of the DB guard. The database stays the authority (see
 * `advanceFromFilter`) — this exists so callers can skip the round trip and so
 * the rule is testable without a database.
 */
export function canAutoAdvance(
  current: { status: string | null; sub_status: string | null },
  key: AutoAdvanceTargetKey
): boolean {
  const rank = stageRank(current.status ?? "", current.sub_status);
  if (rank === null) return false; // terminal off-ramp, or a status we don't understand
  return rank < AUTO_ADVANCE_TARGETS[key].order;
}
