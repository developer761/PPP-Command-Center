/**
 * Shared WorkOrderLineItem.Status filter — single source of truth.
 *
 * Used by:
 *   - `lib/salesforce/queries.ts` (snapshot loader, drives Materials view)
 *   - `lib/customer-form/render-data.ts` (form render, drives Customer color form)
 *
 * Keeping both surfaces in lockstep means a WO can't show different rooms on
 * the materials view vs the customer form (audit-flagged 2026-06-04: two
 * independent Set definitions were a drift waiting to happen).
 *
 * Statuses in this set are HIDDEN — those rooms won't be repainted in this
 * engagement, so showing them would lead to bad supplier orders + customer
 * confusion. Everything else (New, In Progress, On Hold, Pending Approval -
 * ADD, null/blank) stays visible.
 *
 * Verified against PPP's live SF schema 2026-06-03 via
 * `scripts/answer-katies-questions.ts` — Status is the standard FSL field,
 * 9 active picklist values.
 */
export const HIDDEN_WOLI_STATUSES: ReadonlySet<string> = new Set([
  "Canceled",
  "Completed",
  "Closed",
  "Cannot Complete",
  "Pending Approval - REMOVE",
]);

/** True when the WOLI Status indicates a room we should NOT show to admin or
 *  customer. Null/blank status defaults to "show it" (older orgs that don't
 *  populate the field). */
export function isHiddenWoliStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return HIDDEN_WOLI_STATUSES.has(status.trim());
}
