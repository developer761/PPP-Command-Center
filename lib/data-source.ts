import "server-only";

import { getStoredSalesforceCredentials } from "@/lib/salesforce/client";
import { getRepsFromSalesforce } from "@/lib/salesforce/queries";
import type { Rep } from "@/lib/mock-data";
import { reps as mockReps } from "@/lib/mock-data";

/**
 * Single-file data adapter for the Command Center.
 *
 * - If Salesforce is connected (refresh_token in Supabase), pull live data
 *   from SF and return PPP-shaped records.
 * - If SF isn't connected yet OR a query fails, transparently fall back to
 *   the mock data so the UI never crashes.
 *
 * The UI imports type definitions + pure helpers from `lib/mock-data` directly.
 * For live data, the UI awaits these async getters server-side and passes
 * results down to client components.
 */

export {
  // Data shapes — stable across mock + live
  type Period,
  type RegionFilter,
  type SeriesPoint,
  type FilteredView,
  type Rep,
  type Deal,
  type RegionRollup,
  type RepMonthlyPoint,

  // Filter / derivation engine — works against any Rep[] passed in via the
  // optional `repsOverride` param. UI calls these client-side with the
  // server-fetched rep array.
  getFilteredView,
  getFunnelForPeriod,
  getRepMonthly,
  getRepRecentDeals,
  getRegionOptions,
  getRegionColorToken,

  // Static metadata
  PERIOD_LABELS,

  // Reference exports (mock-only until we wire them to SF)
  topPerformer,
  pipelineAtRisk,
  teamTotals,
} from "./mock-data";

/**
 * Returns the list of reps to populate the dashboard. Tries Salesforce first;
 * falls back to mock data if SF isn't connected or a query fails.
 *
 * Server-only. Call from Server Components / Route Handlers, then pass the
 * result down to Client Components as a prop.
 */
export async function getReps(): Promise<{ reps: Rep[]; source: "salesforce" | "mock"; reason?: string }> {
  // 1. Is SF connected at all?
  let creds: Awaited<ReturnType<typeof getStoredSalesforceCredentials>> = null;
  try {
    creds = await getStoredSalesforceCredentials();
  } catch (err) {
    return {
      reps: mockReps,
      source: "mock",
      reason: err instanceof Error ? err.message : "supabase_unavailable",
    };
  }

  if (!creds) {
    return { reps: mockReps, source: "mock", reason: "sf_not_connected" };
  }

  // 2. Try the SF query
  try {
    const reps = await getRepsFromSalesforce();
    if (reps.length === 0) {
      // Sandbox might be empty — degrade to mock so the dashboard still has something to show.
      return { reps: mockReps, source: "mock", reason: "sf_returned_empty" };
    }
    return { reps, source: "salesforce" };
  } catch (err) {
    return {
      reps: mockReps,
      source: "mock",
      reason: err instanceof Error ? err.message : "sf_query_failed",
    };
  }
}
