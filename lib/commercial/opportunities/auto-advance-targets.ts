import { stageRank, subRank, PRE_SALE_OPEN_STATUSES } from "./constants";

/**
 * The ONLY states an automatic move may target.
 *
 * A whitelist rather than "any status", because every trigger the adversarial
 * pass killed (§4b) was a plausible-looking one: won → Pre-Construction skips
 * the Win/Loss debrief and never stamps `decided_at`, so the win vanishes from
 * "Wins this month"; first-invoice → Billing marks a 15%-done AIA job as
 * Billing and forward-only never lets it back; a work order crossing a deal
 * pre→post books delivery on a bid nobody recorded as won. None of those can be
 * expressed here, which is the point.
 *
 * `order` / `subOrder` are the position used for the forward-only comparison.
 * For the live stages they ARE `stageRank` / `subRank` (asserted in the tests,
 * so the two can't drift). Only `closed` needs its own number: `stageRank`
 * deliberately returns null for it — terminal, never a legal source — but it is
 * a legal TARGET, so it sits above the whole ladder at 8.
 */
export type AutoAdvanceTargetKey =
  | "estimating"
  | "estimating_pending"
  | "proposal"
  | "won"
  | "closed";

export type AutoAdvanceTarget = {
  status: string;
  sub_status: string;
  order: number;
  subOrder: number;
  /** Goes in the timeline note, so it reads as the stage a person recognises. */
  label: string;
  /**
   * The exact state this move may start from, when it is a sub-status
   * refinement rather than a climb up the ladder.
   *
   * Only `closed` uses it, and it is load-bearing: `post_sale_closed` is in
   * `TERMINAL_STATUSES`, so writing it from any earlier status stamps
   * `decided_at` with today's date. The dashboard builds its win-rate
   * DENOMINATOR from raw `decided_at`, so auto-closing an old job would quietly
   * move a win into the wrong month. Restricting the source to
   * `post_sale_closed·closeout` keeps the top-level status unchanged, which
   * means no `decided_at` write, no log row and no notification.
   */
  exactFrom?: { status: string; sub_status: string };
};

export const AUTO_ADVANCE_TARGETS: Record<AutoAdvanceTargetKey, AutoAdvanceTarget> = {
  estimating: {
    status: "estimating",
    sub_status: "estimating",
    order: 1,
    subOrder: 0,
    label: "Estimating",
  },
  // Katie's second `estimating` sub-status: priced, awaiting sign-off. Same
  // rank as Estimating — the difference is the sub ladder, not the stage.
  estimating_pending: {
    status: "estimating",
    sub_status: "proposal_pending_approval",
    order: 1,
    subOrder: 1,
    label: "Proposal Pending Approval",
  },
  proposal: { status: "proposal", sub_status: "sent", order: 2, subOrder: 0, label: "Proposal" },
  won: {
    status: "pre_sale_closed",
    sub_status: "won",
    order: 3,
    subOrder: 0,
    label: "Closed Won",
  },
  closed: {
    status: "post_sale_closed",
    sub_status: "closed",
    order: 8,
    subOrder: 1,
    label: "Closed",
    exactFrom: { status: "post_sale_closed", sub_status: "closeout" },
  },
};

/**
 * Maps a proposal's status to the state it justifies — the resulting STATE, not
 * the word "proposal".
 *
 * A draft targets **Estimating**, not Proposal: a draft is work in progress, and
 * advancing to Proposal would fabricate a "sent" deal with no PDF and no
 * approval, walking straight past the send gate.
 *
 * `pending_approval` and `approved` target the *pending-approval sub-status*
 * rather than plain Estimating. Both mean "pricing is done", which is precisely
 * what that sub-status records — and pointing them at plain Estimating would
 * make them a backward move for any deal already there, i.e. no move at all.
 *
 * Returns null for anything that justifies no move.
 */
export function targetForProposalStatus(
  status: string | null | undefined
): AutoAdvanceTargetKey | null {
  switch (status) {
    case "draft":
      return "estimating";
    case "pending_approval":
    case "approved":
      return "estimating_pending";
    case "sent":
      return "proposal";
    case "won":
      return "won";
    default:
      return null;
  }
}

/** Is `a` further along than `b`? Lexicographic on (stage, sub). */
function outranks(a: AutoAdvanceTarget, b: AutoAdvanceTarget): boolean {
  if (a.order !== b.order) return a.order > b.order;
  return a.subOrder > b.subOrder;
}

/**
 * Folds every trigger fired in one request into the single furthest target.
 *
 * Required by §4d.4: a deal with three proposals must produce ONE write, ONE
 * log row and ONE notification. Applying them in sequence would walk the deal up
 * the ladder one stage at a time and spray the timeline with intermediate
 * stages it was never really in.
 */
export function foldAutoAdvanceTargets(
  keys: Array<AutoAdvanceTargetKey | null | undefined>
): AutoAdvanceTargetKey | null {
  let best: AutoAdvanceTargetKey | null = null;
  for (const k of keys) {
    if (!k) continue;
    if (best === null || outranks(AUTO_ADVANCE_TARGETS[k], AUTO_ADVANCE_TARGETS[best])) best = k;
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
  const target = AUTO_ADVANCE_TARGETS[key];
  const status = current.status ?? "";

  // A refinement move names its one legal source outright.
  if (target.exactFrom) {
    return status === target.exactFrom.status && current.sub_status === target.exactFrom.sub_status;
  }

  const rank = stageRank(status, current.sub_status);
  if (rank === null) return false; // terminal off-ramp, or a status we don't understand
  if (rank < target.order) return true;
  // Same rung: a step forward within the status still counts.
  if (rank === target.order && status === target.status) {
    return subRank(status, current.sub_status) < target.subOrder;
  }
  return false;
}

/**
 * Does the current proposal sit BEHIND the deal's stage?
 *
 * This is the state forward-only deliberately leaves alone. Opening an R2 draft
 * on a deal you already sent means the deal is still at Proposal — correctly,
 * because you did send R1 — while the proposals board shows the current
 * proposal as a Draft. Nothing is wrong, but the two screens disagree at a
 * glance, so the card says which state the proposal is actually in rather than
 * leaving someone to guess or, worse, drag the deal backwards to "fix" it.
 *
 * False when there's nothing worth saying: the proposal is level with or ahead
 * of the deal (the engine will catch it up), the deal is closed, or the
 * proposal's status implies no stage at all.
 */
export function proposalTrailsDeal(
  deal: { status: string | null; sub_status: string | null },
  proposalStatus: string | null | undefined
): boolean {
  const key = targetForProposalStatus(proposalStatus);
  if (!key) return false;
  const target = AUTO_ADVANCE_TARGETS[key];

  const status = deal.status ?? "";
  // Only while the deal is still being bid. That's where the pipeline board and
  // the proposals board sit side by side and can be read against each other.
  // Once a deal is won, lost, or in delivery it's settled, and a stray revision
  // sitting in Draft is not a discrepancy anyone needs to act on — badging it
  // would just put noise on a closed card.
  if (!(PRE_SALE_OPEN_STATUSES as readonly string[]).includes(status)) return false;
  const rank = stageRank(status, deal.sub_status);
  if (rank === null) return false;

  return (
    rank > target.order ||
    (rank === target.order &&
      status === target.status &&
      subRank(status, deal.sub_status) > target.subOrder)
  );
}
