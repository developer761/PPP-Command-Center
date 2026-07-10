/**
 * Phase 2 Opportunity Pipeline — shared constants.
 *
 * Hot-deal thresholds + default probabilities live here so the values
 * are one-line tweaks when Alex says "fire hot at $25k instead of $50k."
 * Promote to a commercial_settings row when that demand surfaces.
 *
 * Karan 2026-07-09 Phase A.1: CEO status-model correction (Plan v1.1).
 * All Pre-Contract enum values, DAG transitions, and default probabilities
 * refactored to match Alex's email. Historic v1.0 values are absent —
 * migration 045 backfills them.
 */

/** Default win probability per status. Lib sets these on every status
 *  change UNLESS the user has overridden probability_pct away from
 *  the prior status's default (in which case the override carries over).
 *  follow_up is special: the lib PRESERVES the prior probability (no
 *  default applied) because "waiting on the customer" doesn't change
 *  how likely you are to win — it's a side state. */
export const DEFAULT_PROBABILITY_BY_STATUS: Record<string, number> = {
  solicitation: 10,
  rfp: 20,
  estimating: 40,
  proposal_pending_approval: 55,
  proposal_sent: 65,
  follow_up: 65, // sentinel — lib treats follow_up specially (preserve prior)
  won: 100,
  lost: 0,
};

/** Statuses where "preserve prior probability" applies — used by
 *  changeOpportunityStatus to know NOT to auto-update probability when
 *  transitioning into one of these. follow_up replaces the v1.0 on_hold
 *  role: it means "waiting on the customer", not "canceled or paused",
 *  so probability shouldn't move. */
export const PROBABILITY_PRESERVING_STATUSES: ReadonlySet<string> = new Set([
  "follow_up",
]);

/** Statuses that mean "the bid is settled" — used to auto-set decided_at.
 *  CEO's v1.1 enum drops no_bid; the distinction is preserved via
 *  `lost_reason='no_bid'` (see migration 045). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "won",
  "lost",
]);

/** Predicate form for inline use — eliminates repeated status checks
 *  across the codebase. Accepts unknown so callers don't have to
 *  type-narrow first. */
export function isTerminalOpportunityStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status);
}

/**
 * The status DAG — which `to_status` is allowed from each `from_status`.
 * Drives the quick-flip dropdown on the list page (filters next options
 * to only valid ones) AND the lib-side validation in
 * changeOpportunityStatus (so a tampered URL or stale form can't move
 * a bid sideways into a state that breaks reporting).
 *
 * Conservative rule of thumb: every active state can flip to `follow_up`
 * (waiting on GC) and to `lost` (early kill). Terminal states (won/lost)
 * exit only back to `solicitation` (re-engage from the top of the funnel).
 *
 * v1.1 flow (CEO's email):
 *   solicitation → rfp → estimating → proposal_pending_approval →
 *   proposal_sent → follow_up → (won | lost)
 * Shortcuts allowed at every step — a repeat-customer verbal-yes can
 * fire won from any active state. WARN_TRANSITIONS flags the unusual
 * jumps at the UI layer without blocking.
 */
export const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  solicitation: ["rfp", "estimating", "won", "lost", "follow_up"],
  rfp: ["estimating", "proposal_pending_approval", "proposal_sent", "won", "lost", "follow_up"],
  estimating: ["proposal_pending_approval", "proposal_sent", "won", "lost", "follow_up"],
  proposal_pending_approval: ["proposal_sent", "estimating", "won", "lost", "follow_up"],
  proposal_sent: ["follow_up", "estimating", "won", "lost"],
  follow_up: ["estimating", "proposal_pending_approval", "proposal_sent", "won", "lost"],
  // Terminal states re-enter through solicitation — a Won that reopens
  // is a new bid cycle; a Lost that comes back to us is a new solicitation.
  won: ["solicitation"],
  lost: ["solicitation"],
};

/** Transitions that are technically allowed but unusual enough to deserve
 *  a "are you sure?" warning at the UI layer. Lib accepts them silently;
 *  the warning is purely UX. Keyed by "from→to". */
export const WARN_TRANSITIONS: ReadonlySet<string> = new Set([
  // Early-kill warnings — flagging the user "are you sure you're killing
  // this without trying?"
  "solicitation→lost",
  "rfp→lost",
  // Early-WIN warnings — verbal-yes mid-funnel is real (repeat customers
  // call and commit), but flag in case someone misclicks.
  "solicitation→won",
  "rfp→won",
  "estimating→won",
  // Scope-change re-bid warnings — going back to estimating means
  // discarding pricing work.
  "proposal_sent→estimating",
  "proposal_pending_approval→estimating",
  "follow_up→estimating",
  // Reopen a terminal warning — soft confirmation before re-engaging
  // from won/lost back into the pipeline.
  "won→solicitation",
  "lost→solicitation",
]);

/** Statuses that the LIST-PAGE quick-flip dropdown should NOT expose.
 *  Terminal states (won/lost) need extra fields (loss_reason for lost,
 *  decided_at for both) so we force the user to open the detail page
 *  for those. The list-page dropdown is for fast forward motion. */
export const QUICK_FLIP_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "won",
  "lost",
]);

/** "Hot deal" = high-value AND closing soon AND in an active bid state.
 *  Drives the hot chip filter on the list page. Tunable later.
 *  v1.1: RFP + Estimating + Pending Approval + Proposal Sent + Follow Up
 *  are all active states where a big-$ bid deserves attention. */
export const HOT_DEAL_BID_CENTS = 5_000_000;       // $50,000 high-end
export const HOT_DEAL_DECISION_DAYS = 14;          // proposal_due_at within 14 days
export const HOT_DEAL_ACTIVE_STATUSES: readonly string[] = [
  "rfp",
  "estimating",
  "proposal_pending_approval",
  "proposal_sent",
  "follow_up",
] as const;

/** "Stale opp" = open status + no activity in 14 days. Reuses the same
 *  staleness mental model as accounts but with a tighter window because
 *  opps move faster than accounts. */
export const STALE_OPP_DAYS = 14;

/**
 * Multiplier on STALE_OPP_DAYS for marking an *account* relationship as
 * "cooling" — used on the Account-side Opportunities tab header.
 *
 * Commercial bid cycles run longer than residential. A specific opp
 * stale at 14d is one thing; an account where NO opp has moved in
 * 14 * 4 = 56 days is "the relationship is cooling, reach out." Bumped
 * to its own constant so Alex can tune without digging into page code.
 */
export const STALE_ACCOUNT_OPP_COOLING_MULTIPLIER = 4;

/** Statuses that count as "open" in pipeline reporting + filters.
 *  Excludes terminal states (won, lost).
 *  v1.1: the CEO's Pre-Contract list has 8 statuses; 6 are open. Follow
 *  Up is included because it's the "waiting on GC" bucket that must
 *  remain visible in the pipeline — a bid the client is sitting on
 *  is still a live bid until it's decided. */
export const OPEN_OPP_STATUSES: readonly string[] = [
  "solicitation",
  "rfp",
  "estimating",
  "proposal_pending_approval",
  "proposal_sent",
  "follow_up",
] as const;
