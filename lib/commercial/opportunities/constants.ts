/**
 * Phase 2 Opportunity Pipeline — shared constants.
 *
 * Hot-deal thresholds + default probabilities live here so the values
 * are one-line tweaks when Alex says "fire hot at $25k instead of $50k."
 * Promote to a commercial_settings row when that demand surfaces.
 */

/** Default win probability per status. Lib sets these on every status
 *  change; user can override per-opp via the probability_pct field. */
export const DEFAULT_PROBABILITY_BY_STATUS: Record<string, number> = {
  inquiry: 10,
  site_visit_scheduled: 20,
  site_visit_done: 35,
  estimating: 50,
  proposal_sent: 60,
  negotiating: 75,
  on_hold: 25,
  won: 100,
  lost: 0,
  no_bid: 0,
  reopened: 50,
};

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

/** Statuses that count as "open" in pipeline reporting + filters.
 *  Excludes terminal states (won, lost, no_bid). reopened is treated
 *  as won-style (terminal) — once you re-engage you transition out. */
export const OPEN_OPP_STATUSES: readonly string[] = [
  "inquiry",
  "site_visit_scheduled",
  "site_visit_done",
  "estimating",
  "proposal_sent",
  "negotiating",
  "on_hold",
] as const;
