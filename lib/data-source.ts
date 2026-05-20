/**
 * Single-file adapter boundary between the Command Center UI and its data source.
 *
 * Today: re-exports the mock data + filter engine from `lib/mock-data.ts`.
 * When Salesforce access lands: rewrite the body of each export to call SF
 *   via a server action / Route Handler. The UI does not change.
 *
 * Contract (keep stable across mock → live):
 *   - `getFilteredView(period, region)` returns the FilteredView shape
 *   - `getFunnelForPeriod(period, region)` returns the funnel rows
 *   - `getRepMonthly(repId)` returns the rep's 12-month series
 *   - `getRepRecentDeals(repId)` returns up to N recent deals
 *   - `getRegionOptions()` returns dropdown options derived from current data
 *   - `getRegionColorToken(region)` returns the Tailwind color token (with fallback)
 *
 * Edge cases to handle inside the adapter (NOT the UI):
 *   - Null / missing SF fields → coalesce to safe defaults
 *   - Region values outside the known set → still flow through; color falls back
 *   - Service line values outside Residential/Commercial → bucket sensibly
 *   - Date / timezone normalization → use the user's locale, not UTC
 *   - SF API rate limits → cache per (period, region) tuple
 *   - Stale auth → surface a reconnect signal so the topbar can switch from green to amber
 *
 * Reference: project memory `project_ppp_salesforce_wiring_edge_cases.md` has the
 * full edge-case audit. Re-read before flipping this file from mock → live.
 */

export {
  // Data shapes — kept stable
  type Period,
  type RegionFilter,
  type SeriesPoint,
  type FilteredView,
  type Rep,
  type Deal,
  type RegionRollup,
  type RepMonthlyPoint,

  // Filter / derivation engine — UI calls these
  getFilteredView,
  getFunnelForPeriod,
  getRepMonthly,
  getRepRecentDeals,
  getRegionOptions,
  getRegionColorToken,

  // Static metadata
  PERIOD_LABELS,

  // Reference exports — used by drill-in / insights cards
  topPerformer,
  pipelineAtRisk,
  teamTotals,
  reps,
} from "./mock-data";
