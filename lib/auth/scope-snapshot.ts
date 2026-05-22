import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import type { Viewer } from "@/lib/auth/viewer";

/**
 * Scope a Salesforce snapshot to what the viewer is allowed to see.
 *
 *   - `scope === "all"` (admin only) → returns the snapshot untouched.
 *   - `scope === "my"` with a SF user id → filters opps/WOs/accounts/quotes
 *     to the effective user. The `reps` array is trimmed to just that one rep
 *     so leaderboards and rep pickers don't leak names from other regions.
 *   - `scope === "my"` with NO effective user id (admin with no SF mapping,
 *     no view-as selected) → returns an empty snapshot. Showing "all" data
 *     to an admin who clicked "My" would be a confusing fall-through; an
 *     explicit empty view is the safer default.
 *
 * Pure — derives a new snapshot, doesn't mutate inputs.
 */
export function scopeSnapshotToViewer(
  snapshot: SalesforceSnapshot,
  viewer: Viewer
): SalesforceSnapshot {
  if (viewer.scope === "all") return snapshot;

  const ownerId = viewer.effectiveUserId;
  if (!ownerId) {
    return {
      ...snapshot,
      reps: [],
      opportunities: [],
      workOrders: [],
      accounts: [],
      quotes: [],
    };
  }

  const opportunities = snapshot.opportunities.filter((o) => o.ownerId === ownerId);
  const workOrders = snapshot.workOrders.filter((w) => w.ownerId === ownerId);
  const accounts = snapshot.accounts.filter((a) => a.accountManagerId === ownerId);
  const reps = snapshot.reps.filter((r) => r.id === ownerId);

  // Quotes link to opps via opportunityId — keep only quotes whose opp survived the filter.
  const oppIds = new Set(opportunities.map((o) => o.id));
  const quotes = snapshot.quotes.filter(
    (q) => q.opportunityId && oppIds.has(q.opportunityId)
  );

  return {
    ...snapshot,
    reps,
    opportunities,
    workOrders,
    accounts,
    quotes,
  };
}
