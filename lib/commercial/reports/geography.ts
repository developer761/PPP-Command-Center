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

import { marginFrom, uncostedHoursByOpp } from "@/lib/commercial/projects/financials";
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
  /**
   * Crew hours inside this row that nothing has paid for — so the cost below
   * is short by them and the margin reads high.
   *
   * The row carried no such field and the page printed a bare percentage,
   * which made this the one margin surface with no honesty line at all. It is
   * the PAYOUT-GATED count (`uncostedHoursByOpp`), not the raw unrated total:
   * 14,637 hours read unrated on the live book and 14,589 of them are already
   * paid.
   */
  uncostedHours: number;
  /** The sentence `marginFrom` attaches for those hours, or null. Rendered
   *  rather than re-derived, so a region cannot word it differently from the
   *  deal inside it. */
  marginCaveat: string | null;
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
    /** Payout-gated uncosted crew hours across every deal in the report. */
    uncostedHours: number;
  };
};

const clean = (v: string | null | undefined): string => (v ?? "").trim();
const titleCase = (s: string): string =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
type Acc = {
  dealCount: number;
  contractCents: number;
  billedCents: number;
  totalCostCents: number;
  uncostedHours: number;
  label: string;
  sub: string | null;
};

// `billed` is carried so margin uses the platform basis (billed − cost, D2).
// This aggregate used to sum a contract-based margin, so a region's margin
// disagreed with the margin on every deal inside it.
function bump(
  map: Map<string, Acc>,
  key: string,
  label: string,
  sub: string | null,
  contract: number,
  billed: number,
  cost: number,
  uncostedHours: number
): void {
  const a = map.get(key) ?? { dealCount: 0, contractCents: 0, billedCents: 0, totalCostCents: 0, uncostedHours: 0, label, sub };
  a.dealCount += 1;
  a.contractCents += contract;
  a.billedCents += billed;
  a.totalCostCents += cost;
  a.uncostedHours += uncostedHours;
  map.set(key, a);
}

function finalize(map: Map<string, Acc>): GeoRow[] {
  return [...map.values()]
    .map((a) => {
      // ONE call, not two. Calling it twice for `.cents` and `.pct` also meant
      // the third return value — the caveat — had nowhere to land, which is
      // part of how this surface ended up the one with no honesty line.
      const m = marginFrom(a.billedCents, a.totalCostCents, a.uncostedHours);
      return {
        label: a.label,
        sub: a.sub,
        dealCount: a.dealCount,
        contractCents: a.contractCents,
        totalCostCents: a.totalCostCents,
        marginCents: m.cents,
        marginPct: m.pct,
        uncostedHours: Math.round(a.uncostedHours * 100) / 100,
        marginCaveat: m.caveat,
      };
    })
    // Most jobs first, then biggest contract — "where most jobs are" up top.
    .sort((x, y) => y.dealCount - x.dealCount || y.contractCents - x.contractCents);
}

export async function getGeographyReport(): Promise<GeographyReport> {
  const rows = await listProjects({ includeClosed: true, allDeals: true });
  // One query for the whole portfolio — see uncostedHoursByOpp on why the
  // aggregate path asks the deal-level question rather than the per-person one.
  const coverage = await uncostedHoursByOpp(
    rows.map((p) => ({ oppId: p.opp.id, unratedHours: p.laborUnratedHours }))
  );

  const byCity = new Map<string, Acc>();
  const byZip = new Map<string, Acc>();
  const byState = new Map<string, Acc>();
  let dealCount = 0, located = 0, unspecified = 0, contractTotal = 0, uncostedTotal = 0;

  for (const p of rows) {
    const opp = p.opp as { property_city?: string | null; property_state?: string | null; property_zip?: string | null };
    const city = titleCase(clean(opp.property_city));
    const state = clean(opp.property_state).toUpperCase();
    const zip = clean(opp.property_zip).slice(0, 10);
    // Skip bare deals with nothing to weigh (matches Job Costs' skip so totals tie).
    if (p.contractToDateCents === 0 && p.costsCents === 0 && p.billedContractCents === 0) continue;

    dealCount += 1;
    contractTotal += p.contractToDateCents;
    const uncosted = coverage.get(p.opp.id)?.uncostedHours ?? 0;
    uncostedTotal += uncosted;
    const hasLoc = !!(city || state || zip);
    if (hasLoc) located += 1; else unspecified += 1;

    // KEY ON THE TOWN, not town+state.
    //
    // Keying on `${city}|${state}` while LABELLING with the town alone split
    // Central Islip into two rows both called "Central Islip" — 8 deals whose
    // state is blank and 6 whose state says NY — and counted the town twice in
    // "34 towns". A missing state is missing data, not a second place. The
    // state shown is whichever the town has on record.
    if (city) bump(byCity, city, city, state || null, p.contractToDateCents, p.billedContractCents, p.costsCents, uncosted);
    if (zip) bump(byZip, zip, zip, city || null, p.contractToDateCents, p.billedContractCents, p.costsCents, uncosted);
    if (state) bump(byState, state, state, null, p.contractToDateCents, p.billedContractCents, p.costsCents, uncosted);
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
      uncostedHours: Math.round(uncostedTotal * 100) / 100,
    },
  };
}

/** What this report returns when there is nothing to report. Exported so a page
 *  can degrade one card instead of failing whole. */
export const EMPTY_GEO: GeographyReport = {
  byCity: [],
  byZip: [],
  byState: [],
  totals: {
    dealCount: 0,
    locatedCount: 0,
    unspecifiedCount: 0,
    cityCount: 0,
    zipCount: 0,
    stateCount: 0,
    contractCents: 0,
    uncostedHours: 0,
  },
};
