/**
 * Phase 2 Opportunity Pipeline — shared constants.
 *
 * Hot-deal thresholds + default probabilities live here so the values
 * are one-line tweaks when Alex says "fire hot at $25k instead of $50k."
 * Promote to a commercial_settings row when that demand surfaces.
 */

/** Default win probability per status. Lib sets these on every status
 *  change UNLESS the user has overridden probability_pct away from
 *  the prior status's default (in which case the override carries over).
 *  on_hold is special: the lib PRESERVES the prior probability (no
 *  default applied) because going on hold doesn't change how likely
 *  you are to win — it's a side state. */
export const DEFAULT_PROBABILITY_BY_STATUS: Record<string, number> = {
  inquiry: 10,
  estimating: 50,
  proposal_sent: 60,
  negotiating: 75,
  on_hold: 25, // sentinel — lib treats on_hold specially (preserve prior)
  won: 100,
  lost: 0,
  no_bid: 0,
  reopened: 50,
};

/** Statuses where on_hold-style "preserve prior probability" applies —
 *  used by changeOpportunityStatus to know NOT to auto-update probability
 *  when transitioning into one of these. */
export const PROBABILITY_PRESERVING_STATUSES: ReadonlySet<string> = new Set([
  "on_hold",
]);

/** Statuses that mean "the deal is settled" — used to auto-set decided_at. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "won",
  "lost",
  "no_bid",
]);

/** Predicate form for inline use — eliminates the 8-site repetition of
 *  `s === "won" || s === "lost" || s === "no_bid"` across the codebase.
 *  Accepts unknown so callers don't have to type-narrow first. */
export function isTerminalOpportunityStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status);
}

/**
 * The status DAG — which `to_status` is allowed from each `from_status`.
 * Drives the quick-flip dropdown on the list page (filters next options
 * to only valid ones) AND the lib-side validation in
 * changeOpportunityStatus (so a tampered URL or stale form can't move
 * a deal sideways into a state that breaks reporting).
 *
 * Conservative rule of thumb: every status can always go to `on_hold`
 * (pause it) and to `lost`/`no_bid` (early kill). Terminal-ish states
 * (won/lost/no_bid) exit only to `reopened`.
 */
export const ALLOWED_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  // All active states can flip to ANY terminal (won/lost/no_bid). A repeat
  // customer can call mid-estimate and say "we're going with you" — Won
  // shouldn't require Negotiating first. WARN_TRANSITIONS still flags the
  // unusual jumps (inquiry → won, etc.) at the UI level so users get a
  // soft confirmation prompt; the lib accepts the transition.
  // Karan 2026-06-24: Won was only reachable from Negotiating, breaking
  // the obvious "I just got the verbal" close path from any earlier state.
  inquiry: ["estimating", "won", "lost", "no_bid", "on_hold"],
  estimating: ["proposal_sent", "won", "lost", "no_bid", "on_hold"],
  proposal_sent: ["negotiating", "estimating", "won", "lost", "no_bid", "on_hold"],
  negotiating: ["won", "lost", "no_bid", "on_hold", "estimating"],
  on_hold: ["estimating", "proposal_sent", "negotiating", "won", "lost", "no_bid"],
  won: ["reopened"],
  lost: ["reopened"],
  no_bid: ["reopened"],
  reopened: ["estimating", "proposal_sent", "negotiating", "on_hold", "won", "lost", "no_bid"],
};

/** Transitions that are technically allowed but unusual enough to deserve
 *  a "are you sure?" warning at the UI layer. Lib accepts them silently;
 *  the warning is purely UX. Keyed by "from→to". */
export const WARN_TRANSITIONS: ReadonlySet<string> = new Set([
  // Early-kill warnings — flagging the user "are you sure you're killing
  // this without trying?"
  "inquiry→lost",
  // Early-WIN warnings — verbal-yes mid-funnel is real (repeat customers
  // call and commit), but flag in case someone misclicks.
  "inquiry→won",
  "estimating→won",
  // Scope-change re-bid warnings
  "proposal_sent→estimating",
  "negotiating→estimating",
  // (won→reopened removed 2026-06-24 — Reopen is a dedicated header
  // action on terminal opps, not a dropdown choice, so the warning
  // about "unusual transition" is misleading. Re-engaging a closed
  // customer is a normal motion, not a flagged edge case.)
]);

/** Statuses that the LIST-PAGE quick-flip dropdown should expose. Terminal
 *  states (won/lost/no_bid) need extra fields (loss_reason for lost,
 *  decided_at for all three) so we force the user to open the detail page
 *  for those. The list-page dropdown is for fast forward motion. */
export const QUICK_FLIP_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "won",
  "lost",
  "no_bid",
]);

/** "Hot deal" = high-value AND closing soon AND in an active negotiation
 *  state. Drives the hot chip filter on the list page. Tunable later. */
export const HOT_DEAL_BID_CENTS = 5_000_000;       // $50,000 high-end
export const HOT_DEAL_DECISION_DAYS = 14;          // proposal_due_at within 14 days
export const HOT_DEAL_ACTIVE_STATUSES: readonly string[] = [
  "estimating",
  "proposal_sent",
  "negotiating",
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
 *  Excludes terminal states (won, lost, no_bid).
 *  Karan 2026-06-24: reopened added — it's a transitional state where
 *  the user needs to re-route the deal back into the pipeline. Without
 *  it here, reopened opps disappear from kanban AND list view (filtered
 *  out everywhere), so users couldn't find their reopened deals.
 *  Reopened gets its own kanban column with a "needs re-routing" empty
 *  state so users see them as a queue to clear. */
export const OPEN_OPP_STATUSES: readonly string[] = [
  "inquiry",
  "estimating",
  "proposal_sent",
  "negotiating",
  "on_hold",
  "reopened",
] as const;
