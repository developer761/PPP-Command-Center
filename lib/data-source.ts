import "server-only";

import {
  getStoredSalesforceCredentials,
} from "@/lib/salesforce/client";
import {
  loadSalesforceSnapshot,
  loadMaterialsBundle,
  type SalesforceSnapshot,
} from "@/lib/salesforce/queries";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { scopeSnapshotToViewer } from "@/lib/auth/scope-snapshot";
import type { Viewer } from "@/lib/auth/viewer";
import {
  deriveCompanyTrend,
  deriveRepMonthly,
  deriveRepRecentDeals,
  deriveRepUpcomingWork,
  deriveRepRecentlySentQuotes,
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
 * Data adapter — the single entry point every dashboard page uses to fetch
 * its data. New devs: start here when you're tracing how a page gets its
 * data; this file IS the seam between the page layer + the SF cache layer.
 *
 * `loadDashboardData(searchParams, opts?)` wraps three things into one call:
 *
 *   1. Viewer resolution — reads request cookies + URL params, returns the
 *      canonical Viewer (admin or rep) including any active "view as"
 *      impersonation. See `lib/auth/viewer-server.ts`.
 *   2. Salesforce snapshot — pulled from the cached snapshot layer
 *      (`lib/salesforce/queries.ts`). Always uses the shared cache, never
 *      a per-page fetch.
 *   3. Viewer scoping — `scopeSnapshotToViewer` filters the snapshot so a
 *      worker only sees their own opps/WOs/accounts; admin sees everything.
 *      See `lib/auth/scope-snapshot.ts`.
 *
 * Falls back to in-repo mock data when SF isn't connected — means a new dev
 * can clone the repo, set Supabase + Resend env vars, and the dashboard
 * renders against fake data while they wait for SF credentials. Real SF
 * takes precedence the moment the OAuth refresh token is stored.
 *
 * Thin mode (`opts.thin = true`): skips the heavy opportunity + 6 secondary
 * queries. Used by `/dashboard/materials`, `/dashboard/operations`,
 * `/dashboard/map` — pages that don't read opps. Cuts cold loads from
 * ~8-15s to ~2-4s. See `docs/ARCHITECTURE.md` → "Thin snapshot".
 *
 * UI doesn't care which source it's reading from — same shape either way.
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
  /** Viewer who loaded this bundle (null on mock-mode / unauthenticated). */
  viewer: Viewer | null;
};

/* ─── Live-data accessor used by every page ─── */

/**
 * Load the dashboard bundle for the current viewer. Pages pass their
 * `searchParams` (used to read `?view_as=` and `?scope=`) so the snapshot
 * can be filtered server-side before any derive functions run.
 *
 * Pages that pre-date role-based access can still call this with no args
 * — they'll get the unscoped snapshot, which is correct because they don't
 * yet honor viewer state. (Strict scoping kicks in once a page opts in.)
 */
export async function loadDashboardData(
  searchParams?: Record<string, string | string[] | undefined>,
  opts?: { thin?: boolean; materials?: boolean; forceRebuild?: boolean }
): Promise<LiveDashboardBundle> {
  // Viewer + creds are both pure Supabase round-trips with no dependency on
  // each other — running them concurrently shaves 50-200ms off every page
  // load (more noticeable on warm SF cache where these two are the only
  // synchronous work left). allSettled so a creds failure still surfaces a
  // resolved viewer (which the mock-fallback branches read).
  const [viewerResult, credsResult] = await Promise.allSettled([
    searchParams ? resolveViewer(searchParams) : Promise.resolve(null),
    getStoredSalesforceCredentials(),
  ]);

  const viewer = viewerResult.status === "fulfilled" ? viewerResult.value : null;

  if (credsResult.status === "rejected") {
    return {
      source: "mock",
      reason: credsResult.reason instanceof Error
        ? credsResult.reason.message
        : "supabase_unavailable",
      snapshot: null,
      viewer,
    };
  }
  const creds = credsResult.value;
  if (!creds) {
    return { source: "mock", reason: "sf_not_connected", snapshot: null, viewer };
  }
  try {
    // Materials page opts in to the pre-derived materials bundle (~200KB)
    // instead of the thin snapshot (~5-10MB) — same shape, much smaller blob.
    // Falls back to the thin loader implicitly inside loadMaterialsBundle
    // if anything goes wrong (the cached() wrapper retries on rejection).
    const raw = opts?.materials
      ? await loadMaterialsBundle()
      : await loadSalesforceSnapshot({ thin: opts?.thin, forceRebuild: opts?.forceRebuild });
    if (raw.reps.length === 0) {
      return { source: "mock", reason: "sf_returned_no_reps", snapshot: null, viewer };
    }
    const snapshot = viewer ? scopeSnapshotToViewer(raw, viewer) : raw;
    return { source: "salesforce", snapshot, viewer };
  } catch (err) {
    return {
      source: "mock",
      reason: err instanceof Error ? err.message : "sf_query_failed",
      snapshot: null,
      viewer,
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

export function getRepUpcomingWorkFor(
  bundle: LiveDashboardBundle,
  repId: string
): Deal[] | null {
  if (bundle.snapshot) return deriveRepUpcomingWork(bundle.snapshot, repId);
  return null;
}

export function getRepRecentlySentQuotesFor(
  bundle: LiveDashboardBundle,
  repId: string
): Deal[] | null {
  if (bundle.snapshot) return deriveRepRecentlySentQuotes(bundle.snapshot, repId);
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
