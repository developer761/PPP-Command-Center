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
      woLineItems: [],
      // leadStats is a COMPANY-WIDE aggregate (no per-rep breakdown available).
      // Zero it in scoped views or a worker's Conversion Rate card would show
      // whole-company Leads→Opps numbers on their own scoped dashboard — both a
      // cross-scope data exposure and a semantically wrong figure. Zeroed →
      // dashboard hides the card (it only renders when leadStats.total > 0).
      leadStats: { total: 0, converted: 0 },
      // Paint colors are a global directory — leave intact so the materials
      // page can resolve names even if no WOLI rows survive scoping.
    };
  }

  const opportunities = snapshot.opportunities.filter((o) => o.ownerId === ownerId);
  const workOrders = snapshot.workOrders.filter((w) => w.ownerId === ownerId);
  const reps = snapshot.reps.filter((r) => r.id === ownerId);

  // Account scoping — a rep "owns" a customer in three ways:
  //   1. They're listed as the Account Manager (Account.AccountManager__c)
  //   2. They own at least one Opp or WO on that account (by Account.Id)
  //   3. Legacy fallback: their WO/Opp's accountName matches an Account.name
  //      (covers the small set of pre-2026 records that don't carry accountId)
  // ID-based matching is the canonical path — name-based was the only path
  // before this commit, which silently collided when two Accounts shared a
  // name. We keep the name path as a fallback so existing data still works.
  const accountIdsTouched = new Set<string>();
  const accountNamesTouched = new Set<string>();
  for (const w of workOrders) {
    if (w.accountId) accountIdsTouched.add(w.accountId);
    else if (w.accountName) accountNamesTouched.add(w.accountName);
  }
  for (const o of opportunities) {
    if (o.accountId) accountIdsTouched.add(o.accountId);
    else if (o.accountName) accountNamesTouched.add(o.accountName);
  }
  const accounts = snapshot.accounts.filter(
    (a) =>
      a.accountManagerId === ownerId ||
      accountIdsTouched.has(a.id) ||
      // Name fallback ONLY when this rep has no ID-bearing records at all
      // (pure-legacy data). With any modern accountId present we must NOT
      // name-match — two customers sharing a name would cross-leak, since
      // accountNamesTouched can't distinguish them. Under-including one of
      // a rep's own legacy accounts is acceptable; leaking another rep's
      // customer is not.
      (!accountIdsTouched.size && accountNamesTouched.has(a.name))
  );

  // Quotes link to opps via opportunityId — keep only quotes whose opp survived the filter.
  const oppIds = new Set(opportunities.map((o) => o.id));
  const quotes = snapshot.quotes.filter(
    (q) => q.opportunityId && oppIds.has(q.opportunityId)
  );

  // WOLI rows link to WorkOrder via workOrderId. Keep only line items whose
  // parent WO survived the owner filter so reps see only their own jobs.
  const woIds = new Set(workOrders.map((w) => w.id));
  const woLineItems = snapshot.woLineItems.filter((l) => woIds.has(l.workOrderId));

  return {
    ...snapshot,
    reps,
    opportunities,
    workOrders,
    accounts,
    quotes,
    woLineItems,
    // leadStats is a COMPANY-WIDE aggregate (Lead.ConvertedOpportunityId carries
    // no owner we can filter on). Leaving it intact would render whole-company
    // Leads→Opps on a worker's scoped Conversion Rate card — a cross-scope leak
    // AND a wrong number for that rep. Zero it so the card hides in scoped views.
    leadStats: { total: 0, converted: 0 },
    // Paint colors stay full — they're a 5k-row directory used to resolve
    // color references; not sensitive and not viewer-scoped data.
  };
}
