import "server-only";

/**
 * Geography report — WHERE the work is. Aggregates every deal by job-site
 * location (property_city / property_state / property_zip on the opportunity)
 * so the team can see which towns + zips drive the most jobs, contract dollars,
 * and margin. Built on listProjects (the same source as Job Costs + the
 * dashboard), so contract/cost/margin here tie out with those surfaces.
 *
 * A deal with no location logged rolls into an "unspecified" tally surfaced as a
 * data-quality nudge — never silently dropped, so counts always reconcile with
 * the Job Costs total.
 *
 * All amounts are integer cents.
 */

import { marginFrom } from "@/lib/commercial/projects/financials";
import { listProjects } from "@/lib/commercial/projects/db";

export type GeoRow = {
  /** Display key — "Huntington, NY" / a bare zip / a state code. */
  label: string;
  /** Sub-label for city rows (state) or zip rows (city). */
  sub: string | null;
  dealCount: number;
  contractCents: number;
  totalCostCents: number;
  marginCents: number;
  marginPct: number | null;
};

export type GeographyReport = {
  byCity: GeoRow[];
  byZip: GeoRow[];
  byState: GeoRow[];
  totals: {
    dealCount: number;
    locatedCount: number;
    /** Deals with NO city/zip/state logged (data-quality gap). */
    unspecifiedCount: number;
    cityCount: number;
    zipCount: number;
    stateCount: number;
    contractCents: number;
  };
};

const clean = (v: string | null | undefined): string => (v ?? "").trim();
const titleCase = (s: string): string =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
type Acc = { dealCount: number; contractCents: number; billedCents: number; totalCostCents: number; label: string; sub: string | null };

// `billed` is carried so margin uses the platform basis (billed − cost, D2).
// This aggregate used to sum a contract-based margin, so a region's margin
// disagreed with the margin on every deal inside it.
function bump(map: Map<string, Acc>, key: string, label: string, sub: string | null, contract: number, billed: number, cost: number): void {
  const a = map.get(key) ?? { dealCount: 0, contractCents: 0, billedCents: 0, totalCostCents: 0, label, sub };
  a.dealCount += 1;
  a.contractCents += contract;
  a.billedCents += billed;
  a.totalCostCents += cost;
  map.set(key, a);
}

function finalize(map: Map<string, Acc>): GeoRow[] {
  return [...map.values()]
    .map((a) => ({
      label: a.label,
      sub: a.sub,
      dealCount: a.dealCount,
      contractCents: a.contractCents,
      totalCostCents: a.totalCostCents,
      marginCents: marginFrom(a.billedCents, a.totalCostCents).cents,
      marginPct: marginFrom(a.billedCents, a.totalCostCents).pct,
    }))
    // Most jobs first, then biggest contract — "where most jobs are" up top.
    .sort((x, y) => y.dealCount - x.dealCount || y.contractCents - x.contractCents);
}

export async function getGeographyReport(): Promise<GeographyReport> {
  const rows = await listProjects({ includeClosed: true, allDeals: true });

  const byCity = new Map<string, Acc>();
  const byZip = new Map<string, Acc>();
  const byState = new Map<string, Acc>();
  let dealCount = 0, located = 0, unspecified = 0, contractTotal = 0;

  for (const p of rows) {
    const opp = p.opp as { property_city?: string | null; property_state?: string | null; property_zip?: string | null };
    const city = titleCase(clean(opp.property_city));
    const state = clean(opp.property_state).toUpperCase();
    const zip = clean(opp.property_zip).slice(0, 10);
    // Skip bare deals with nothing to weigh (matches Job Costs' skip so totals tie).
    if (p.contractToDateCents === 0 && p.costsCents === 0 && p.billedContractCents === 0) continue;

    dealCount += 1;
    contractTotal += p.contractToDateCents;
    const hasLoc = !!(city || state || zip);
    if (hasLoc) located += 1; else unspecified += 1;

    if (city) bump(byCity, `${city}|${state}`, city, state || null, p.contractToDateCents, p.billedContractCents, p.costsCents);
    if (zip) bump(byZip, zip, zip, city || null, p.contractToDateCents, p.billedContractCents, p.costsCents);
    if (state) bump(byState, state, state, null, p.contractToDateCents, p.billedContractCents, p.costsCents);
  }

  return {
    byCity: finalize(byCity),
    byZip: finalize(byZip),
    byState: finalize(byState),
    totals: {
      dealCount,
      locatedCount: located,
      unspecifiedCount: unspecified,
      cityCount: byCity.size,
      zipCount: byZip.size,
      stateCount: byState.size,
      contractCents: contractTotal,
    },
  };
}
