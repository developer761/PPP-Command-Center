import "server-only";

/**
 * Job Costs / Profitability report — the detailed cost + margin view across
 * every deal, grouped deal → GC (account) → whole platform. Built entirely on
 * listProjects (the ONE source the deal Costs tab, account rollup, and the
 * dashboard already use), so every number here reconciles with those surfaces
 * to the penny — including the auto crew-labor cost (Option A).
 *
 * Cost columns split materials · subcontract labor (manual 1099) · CREW labor
 * (auto, from time entries) · subcontractor · equipment · permit · other, so the
 * report shows exactly where a job's money went. Margin is CONTRACT-based
 * (contract − total cost) — the same "Gross margin" the deal Costs tab leads
 * with, so a report row drills straight into a matching Costs tab. Billed is
 * shown alongside for cash-flow context (a job can be profitable on paper but
 * not yet billed).
 *
 * All amounts are integer cents.
 */

import { listProjects, type ProjectRow } from "@/lib/commercial/projects/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

/** The seven cost buckets a job can carry, in display order. `subLabor` is the
 *  manual "labor" purchase category (renamed Subcontract labor); `crewLabor` is
 *  the auto field-ops cost. */
export type CostBuckets = {
  materials: number;
  crewLabor: number;
  subLabor: number;
  subcontractor: number;
  equipment: number;
  permit: number;
  other: number;
};

export type JobCostRow = {
  oppId: string;
  accountId: string;
  dealName: string;
  status: string;
  contractCents: number;
  billedCents: number;
  buckets: CostBuckets;
  totalCostCents: number;
  /** Contract − total cost. Negative = projected loss. */
  marginCents: number;
  /** margin ÷ contract, whole %, null when no contract. */
  marginPct: number | null;
  /** Approved crew hours with no cost rate (labor understated until set). */
  laborUnratedHours: number;
};

export type JobCostAccountGroup = {
  accountId: string;
  accountName: string;
  deals: JobCostRow[];
  contractCents: number;
  billedCents: number;
  buckets: CostBuckets;
  totalCostCents: number;
  marginCents: number;
  marginPct: number | null;
  laborUnratedHours: number;
};

export type JobCostsReport = {
  groups: JobCostAccountGroup[];
  totals: {
    dealCount: number;
    accountCount: number;
    contractCents: number;
    billedCents: number;
    buckets: CostBuckets;
    totalCostCents: number;
    marginCents: number;
    marginPct: number | null;
    laborUnratedHours: number;
  };
};

const emptyBuckets = (): CostBuckets => ({
  materials: 0, crewLabor: 0, subLabor: 0, subcontractor: 0, equipment: 0, permit: 0, other: 0,
});

function addBuckets(into: CostBuckets, from: CostBuckets): void {
  into.materials += from.materials;
  into.crewLabor += from.crewLabor;
  into.subLabor += from.subLabor;
  into.subcontractor += from.subcontractor;
  into.equipment += from.equipment;
  into.permit += from.permit;
  into.other += from.other;
}

function rowBuckets(p: ProjectRow): CostBuckets {
  return {
    materials: p.costs.materials,
    crewLabor: p.fieldOpsLaborCents,
    subLabor: p.costs.labor,
    subcontractor: p.costs.subcontractor,
    equipment: p.costs.equipment,
    permit: p.costs.permit,
    other: p.costs.other,
  };
}

const pct = (margin: number, contract: number): number | null =>
  contract > 0 ? Math.round((margin / contract) * 100) : null;

/**
 * Build the Job Costs report. Scope mirrors the dashboard P&L: EVERY deal incl.
 * closed + pre-sale bids (allDeals), so a bid's logged costs still show and the
 * report is a strict superset of any single deal's Costs tab. Deals with a
 * contract OR any cost OR any billing are included; a bare lead with nothing
 * logged is dropped so the report isn't padded with empty rows.
 */
export async function getJobCostsReport(): Promise<JobCostsReport> {
  const rows = await listProjects({ includeClosed: true, allDeals: true });

  const groupsById = new Map<string, JobCostAccountGroup>();
  const totalsBuckets = emptyBuckets();
  let tContract = 0, tBilled = 0, tCost = 0, tUnrated = 0, dealCount = 0;

  for (const p of rows) {
    const buckets = rowBuckets(p);
    const totalCost = p.costsCents;
    // Skip bare deals with nothing to report (no contract, no cost, no billing).
    if (p.contractToDateCents === 0 && totalCost === 0 && p.billedContractCents === 0) continue;

    const row: JobCostRow = {
      oppId: p.opp.id,
      accountId: p.accountId,
      // No account prefix — the GC group header already names the account.
      dealName: derivedOppName(p.opp, ""),
      status: p.opp.status,
      contractCents: p.contractToDateCents,
      billedCents: p.billedContractCents,
      buckets,
      totalCostCents: totalCost,
      marginCents: p.grossMarginCents,
      marginPct: p.grossMarginPct,
      laborUnratedHours: p.laborUnratedHours,
    };

    let g = groupsById.get(p.accountId);
    if (!g) {
      g = {
        accountId: p.accountId,
        accountName: p.accountName || "Unassigned account",
        deals: [],
        contractCents: 0, billedCents: 0, buckets: emptyBuckets(),
        totalCostCents: 0, marginCents: 0, marginPct: null, laborUnratedHours: 0,
      };
      groupsById.set(p.accountId, g);
    }
    g.deals.push(row);
    g.contractCents += row.contractCents;
    g.billedCents += row.billedCents;
    addBuckets(g.buckets, buckets);
    g.totalCostCents += totalCost;
    g.marginCents += row.marginCents;
    g.laborUnratedHours += row.laborUnratedHours;

    tContract += row.contractCents;
    tBilled += row.billedCents;
    addBuckets(totalsBuckets, buckets);
    tCost += totalCost;
    tUnrated += row.laborUnratedHours;
    dealCount += 1;
  }

  const groups = [...groupsById.values()];
  for (const g of groups) {
    g.marginPct = pct(g.marginCents, g.contractCents);
    // Costliest-contract deals first within a GC.
    g.deals.sort((a, b) => b.contractCents - a.contractCents || b.totalCostCents - a.totalCostCents);
  }
  // Biggest GC (by contract) first.
  groups.sort((a, b) => b.contractCents - a.contractCents || b.totalCostCents - a.totalCostCents);

  return {
    groups,
    totals: {
      dealCount,
      accountCount: groups.length,
      contractCents: tContract,
      billedCents: tBilled,
      buckets: totalsBuckets,
      totalCostCents: tCost,
      marginCents: tContract - tCost,
      marginPct: pct(tContract - tCost, tContract),
      laborUnratedHours: tUnrated,
    },
  };
}

/** Cost-bucket column metadata (label + order) — shared by the report UI + CSV
 *  so they never drift. */
export const COST_BUCKET_COLUMNS: { key: keyof CostBuckets; label: string }[] = [
  { key: "materials", label: "Materials" },
  { key: "crewLabor", label: "Crew labor" },
  { key: "subLabor", label: "Subcontract labor" },
  { key: "subcontractor", label: "Subcontractor" },
  { key: "equipment", label: "Equipment" },
  { key: "permit", label: "Permit" },
  { key: "other", label: "Other" },
];
