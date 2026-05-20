import "server-only";

import {
  getStoredSalesforceCredentials,
} from "@/lib/salesforce/client";
import {
  loadSalesforceSnapshot,
  type SalesforceSnapshot,
} from "@/lib/salesforce/queries";
import {
  deriveCompanyTrend,
  deriveRepMonthly,
  deriveRepRecentDeals,
  deriveRepsForPeriod,
  derivePeriodDelta,
  derivePipelineAtRisk,
  deriveTopPerformer,
} from "@/lib/salesforce/derive";
import { reps as mockReps } from "@/lib/mock-data";
import type {
  Deal,
  Period,
  Rep,
  RepMonthlyPoint,
  SeriesPoint,
} from "@/lib/mock-data";

/**
 * Data adapter for the Command Center.
 *
 * When SF is connected and queryable, every page pulls from `loadDashboardData`,
 * which returns a single snapshot-derived bundle. When SF isn't connected, the
 * mock data fills in. UI doesn't care which source it's reading from — same shape.
 */

export {
  // Data shape re-exports — stable across mock + live
  type Period,
  type RegionFilter,
  type SeriesPoint,
  type FilteredView,
  type Rep,
  type Deal,
  type RegionRollup,
  type RepMonthlyPoint,

  // Pure derivation helpers (work for any rep source)
  getFilteredView,
  getFunnelForPeriod,
  getRegionColorToken,
  getRegionOptionsFor,

  // Static metadata
  PERIOD_LABELS,
} from "./mock-data";

/** Source label so the UI can show a small banner when running on mock. */
export type DataSource = "salesforce" | "mock";

export type LiveDashboardBundle = {
  source: DataSource;
  reason?: string;
  /** Snapshot of raw SF data, when available. Pages re-derive everything from this. */
  snapshot: SalesforceSnapshot | null;
};

/* ─── Live-data accessor used by every page ─── */

export async function loadDashboardData(): Promise<LiveDashboardBundle> {
  let creds: Awaited<ReturnType<typeof getStoredSalesforceCredentials>> = null;
  try {
    creds = await getStoredSalesforceCredentials();
  } catch (err) {
    return {
      source: "mock",
      reason: err instanceof Error ? err.message : "supabase_unavailable",
      snapshot: null,
    };
  }
  if (!creds) {
    return { source: "mock", reason: "sf_not_connected", snapshot: null };
  }
  try {
    const snapshot = await loadSalesforceSnapshot();
    if (snapshot.reps.length === 0) {
      return { source: "mock", reason: "sf_returned_no_reps", snapshot: null };
    }
    return { source: "salesforce", snapshot };
  } catch (err) {
    return {
      source: "mock",
      reason: err instanceof Error ? err.message : "sf_query_failed",
      snapshot: null,
    };
  }
}

/* ─── Convenience getters used by individual pages ─── */

/** Reps for the given period — derived from snapshot when live, else mock. */
export function getRepsFor(bundle: LiveDashboardBundle, period: Period): Rep[] {
  if (bundle.snapshot) return deriveRepsForPeriod(bundle.snapshot, period);
  return mockReps;
}

export function getTopPerformerFor(
  bundle: LiveDashboardBundle,
  period: Period
): { id: string; name: string; region: string; revenue: number; closeRate: number } | null {
  if (bundle.snapshot) return deriveTopPerformer(bundle.snapshot, period);
  return null;
}

export function getPipelineAtRiskFor(
  bundle: LiveDashboardBundle
): { value: number; count: number; reps: number } | null {
  if (bundle.snapshot) return derivePipelineAtRisk(bundle.snapshot);
  return null;
}

export function getCompanyTrendFor(
  bundle: LiveDashboardBundle,
  period: Period
): { granularity: "daily" | "monthly"; series: SeriesPoint[] } | null {
  if (bundle.snapshot) return deriveCompanyTrend(bundle.snapshot, period);
  return null;
}

export function getRevenueKpiFor(
  bundle: LiveDashboardBundle,
  period: Period
): { value: number; change: number; trend: "up" | "down" | "flat" } | null {
  if (bundle.snapshot) return derivePeriodDelta(bundle.snapshot, period);
  return null;
}

export function getRepMonthlyFor(
  bundle: LiveDashboardBundle,
  repId: string
): RepMonthlyPoint[] | null {
  if (bundle.snapshot) return deriveRepMonthly(bundle.snapshot, repId);
  return null;
}

export function getRepRecentDealsFor(
  bundle: LiveDashboardBundle,
  repId: string
): Deal[] | null {
  if (bundle.snapshot) return deriveRepRecentDeals(bundle.snapshot, repId);
  return null;
}

/**
 * Convenience for back-compat with pages that haven't been refactored to the
 * bundle pattern yet — returns the current reps as before, period default = 30d.
 */
export async function getReps(): Promise<{ reps: Rep[]; source: DataSource; reason?: string }> {
  const bundle = await loadDashboardData();
  if (bundle.snapshot) {
    return { reps: deriveRepsForPeriod(bundle.snapshot, "30d"), source: bundle.source };
  }
  return { reps: mockReps, source: bundle.source, reason: bundle.reason };
}
