import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import { deriveFinancials } from "@/lib/salesforce/derive";
import { byPeriod } from "@/lib/dashboard/periods";

/**
 * Financials, derived on the server.
 *
 * /dashboard/financials measured 63.6MB and 12.0 seconds against production
 * on 2026-10-16, off a 200ms time to first byte — the page handed the whole
 * Salesforce snapshot to a "use client" component, so React serialized it
 * into the HTML. See lib/dashboard/overview-data.ts for the full set of
 * measurements.
 *
 * The period dropdown here is LOCAL state, not URL-synced, so deriving only
 * the current period would turn every dropdown change into a navigation.
 * `deriveFinancials` returns bounded rollups (top-N lists and scalars), so
 * precomputing all of them is a few tens of KB and the dropdown stays
 * instant.
 */
export type FinancialsData = {
  isSandbox: boolean;
  byPeriod: Record<string, ReturnType<typeof deriveFinancials>>;
};

export function deriveFinancialsData(snapshot: SalesforceSnapshot): FinancialsData {
  return {
    isSandbox: !!snapshot.isSandbox,
    byPeriod: byPeriod((p) => deriveFinancials(snapshot, p)),
  };
}
