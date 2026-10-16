import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import { deriveOperations } from "@/lib/salesforce/derive";
import { byPeriod } from "@/lib/dashboard/periods";

/**
 * Operations, derived on the server.
 *
 * /dashboard/operations measured 35.1MB and 4.7 seconds against production
 * on 2026-10-16 — it already used the THIN snapshot, which is why it was
 * 35MB rather than 64MB, and which is also the proof that shrinking what
 * the server reads does nothing for a page whose cost is what it sends.
 * See lib/dashboard/overview-data.ts.
 *
 * Same reasoning as financials: the period dropdown is local state, and
 * deriveOperations returns bounded rollups (overRuns and topGPMargin are
 * both sliced to 10), so every period is precomputed and switching stays
 * instant.
 */
export type OperationsData = {
  isSandbox: boolean;
  byPeriod: Record<string, ReturnType<typeof deriveOperations>>;
};

export function deriveOperationsData(snapshot: SalesforceSnapshot): OperationsData {
  return {
    isSandbox: !!snapshot.isSandbox,
    byPeriod: byPeriod((p) => deriveOperations(snapshot, p)),
  };
}
