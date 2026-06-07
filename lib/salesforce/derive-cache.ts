import type { SalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Per-snapshot memoization helper for derive functions that get called
 * multiple times per request with the same snapshot reference but different
 * args (e.g. deriveRepScorecard(snap, repA), then deriveRepScorecard(snap,
 * repB), then again later in the same request).
 *
 * Key design:
 *   - Outer WeakMap keyed by the snapshot OBJECT reference. When the
 *     snapshot is rebuilt (every 30 min, or on writeback invalidation),
 *     the old snapshot becomes garbage-collectable and the WeakMap entry
 *     vanishes automatically — no manual cleanup, no stale data risk.
 *   - Inner Map keyed by a caller-provided string (typically `${argA}:${argB}`).
 *
 * Safety: snapshot is treated as immutable; derive functions are pure.
 * If a future derive ever mutates the snapshot in-place, it would
 * invalidate this contract — but pure derivation is the rule per the
 * derive.ts header.
 *
 * Cost: roughly zero on miss (one WeakMap.get + one Map.get), zero on
 * hit (returns the cached value). PPP scale is ~29 reps × N derive
 * functions × ~6 simultaneous snapshot generations in memory → at most
 * a few hundred entries, all garbage-collected when the snapshot is.
 *
 * Audit 2026-06-08: introduced to memoize heavy rep-page derives that
 * each iterate snapshot.opportunities (89k rows) so repeat /dashboard/
 * rep/[id] views in the same session don't re-pay the iteration cost.
 *
 * VIEWER SCOPING + MEMOIZATION (important):
 *   `loadDashboardData` runs `scopeSnapshotToViewer` for non-admin viewers,
 *   which returns a NEW snapshot object (filtered to the viewer's WOs/opps).
 *   Because the WeakMap is keyed by the snapshot REFERENCE, an admin viewing
 *   the full snapshot and a worker viewing the scoped snapshot get SEPARATE
 *   cache entries — cross-scope leakage is impossible. This is correct and
 *   intentional; future devs editing this should preserve the reference
 *   identity contract.
 */
const cache: WeakMap<SalesforceSnapshot, Map<string, unknown>> = new WeakMap();

export function memoBySnapshot<T>(
  snapshot: SalesforceSnapshot,
  fnName: string,
  argKey: string,
  compute: () => T,
): T {
  let inner = cache.get(snapshot);
  if (!inner) {
    inner = new Map();
    cache.set(snapshot, inner);
  }
  const key = `${fnName}:${argKey}`;
  if (inner.has(key)) {
    return inner.get(key) as T;
  }
  const value = compute();
  inner.set(key, value);
  return value;
}
