import type { SalesforceSnapshot } from "@/lib/salesforce/queries";
import {
  deriveRepsForPeriod,
  deriveRepAccountStats,
  deriveRepMomentum,
  derivePeriodDelta,
} from "@/lib/salesforce/derive";
import { byPeriod, ALL_PERIODS } from "@/lib/dashboard/periods";
import type { Rep } from "@/lib/mock-data";

/**
 * The Rep Profiles index, derived on the server.
 *
 * /dashboard/rep measured 63.7MB and 6.4 seconds against production on
 * 2026-10-16 — the whole Salesforce snapshot serialized into the HTML so a
 * "use client" component could derive 26 rep cards out of it. See
 * lib/dashboard/overview-data.ts for the full set of measurements.
 *
 * The period dropdown is local state rather than URL-synced, so everything
 * period-dependent is precomputed for all of them and the dropdown stays
 * instant. Search, region filter and sorting all run off `reps`, which is
 * 26 rows, so those stay instant too.
 *
 * Maps are shipped as plain objects: the call sites use `.get()`, so the
 * view rebuilds Maps from these — 26 entries, free — rather than every
 * lookup changing shape.
 */
export type RepIndexData = {
  isSandbox: boolean;
  repsByPeriod: Record<string, Rep[]>;
  /** Company-wide revenue in $K for the period — always ≥ team revenue; the
   *  gap is the un-attributed work the view deliberately surfaces. */
  companyRevenueByPeriod: Record<string, number>;
  accountStatsByRep: Record<string, ReturnType<typeof deriveRepAccountStats>>;
  momentumByRep: Record<string, { thisWeek: number; priorWeek: number; deltaPct: number }>;
};

export function deriveRepIndexData(snapshot: SalesforceSnapshot): RepIndexData {
  // Rep Profiles shows only PPP's field team (Katie 2026-05-29) — profiles
  // *Standard.Field / *Experience / *Wallpapers / *Tomco + Michael Zilberman,
  // flagged via isFieldStandard. Non-field users (admins / other managers /
  // office) are filtered out. Mock reps have isFieldStandard=undefined → kept.
  const repsByPeriod = byPeriod((p) =>
    deriveRepsForPeriod(snapshot, p).filter((r) => r.isFieldStandard !== false)
  );

  // Account stats are keyed on rep id alone — no period in them. Computed
  // over the UNION of every period's rep set so switching period can never
  // land on a rep whose stats were never built.
  const everyRepId = new Set<string>();
  for (const p of ALL_PERIODS) {
    for (const r of repsByPeriod[p]) everyRepId.add(r.id);
  }
  const accountStatsByRep: RepIndexData["accountStatsByRep"] = {};
  for (const id of everyRepId) {
    accountStatsByRep[id] = deriveRepAccountStats(snapshot, id);
  }

  const momentumByRep: RepIndexData["momentumByRep"] = {};
  for (const [id, m] of deriveRepMomentum(snapshot)) momentumByRep[id] = m;

  return {
    isSandbox: !!snapshot.isSandbox,
    repsByPeriod,
    companyRevenueByPeriod: byPeriod((p) => derivePeriodDelta(snapshot, p).value),
    accountStatsByRep,
    momentumByRep,
  };
}
