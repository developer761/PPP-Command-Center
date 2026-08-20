import "server-only";

import {
  listCommercialOpportunities,
  weightedPipelineCents,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import { PRE_SALE_OPEN_STATUSES } from "@/lib/commercial/opportunities/constants";
import {
  PRE_CONTRACT_COLUMNS,
  OPEN_COLUMN_KEYS,
  columnKeyForOpp,
} from "@/lib/commercial/opportunities/kanban-columns";
import { listCurrentProposalTotalByOpp } from "@/lib/commercial/proposals/db";

/**
 * Pipeline report (R4) — open pre-sale opportunities grouped by stage, with the
 * count, total bid value (unweighted, the mid of the bid range), and the
 * weighted "expected" value (bid mid × win probability). "Open" = the same
 * PRE_SALE_OPEN_STATUSES the dashboard uses, so this reconciles with the
 * dashboard's Pipeline number.
 */

export type PipelineStageRow = {
  status: string;
  label: string;
  count: number;
  bidCents: number;
  weightedCents: number;
  /** bid ÷ count — the average open deal size at this stage. */
  avgDealCents: number;
  /** weighted ÷ bid — the blended win probability the pipeline is priced at. */
  probabilityPct: number | null;
};

export type PipelineReport = {
  rows: PipelineStageRow[];
  totals: {
    count: number;
    bidCents: number;
    weightedCents: number;
    avgDealCents: number;
    /** Blended win probability across the open book (weighted ÷ bid). */
    probabilityPct: number | null;
  };
};

/** Stages, in board order. Derived from the kanban columns so this report
 *  names the same stages the pipeline shows — the hand-written three-row
 *  version omitted Request for Proposal entirely and lumped every
 *  priced-but-unsent deal under Estimating. */
const STAGE_ORDER: { status: string; label: string }[] = PRE_CONTRACT_COLUMNS
  .filter((c) => OPEN_COLUMN_KEYS.includes(c.key))
  .map((c) => ({
    status: c.key,
    // The "proposal" override died with the rename — the column is called
    // Sent now, which is what the report should say too.
    label: c.label,
  }));

/** Unweighted value of a deal in cents: the mid of the bid range, falling
 *  back to the deal's current proposal total when no range is set (deals
 *  created since the bid fields were removed from the create forms). */
export function bidMidCents(
  o: CommercialOpportunity,
  proposalTotalCents?: number | null
): number {
  const low = o.bid_value_low_cents;
  const high = o.bid_value_high_cents;
  if ((low === null || low === undefined) && (high === null || high === undefined)) {
    return proposalTotalCents ?? 0;
  }
  if (low != null && high != null) return Math.round((low + high) / 2);
  return (low ?? high) ?? 0;
}

export async function getPipelineReport(): Promise<PipelineReport> {
  const opps = await listCommercialOpportunities({});
  const open = opps.filter((o) => PRE_SALE_OPEN_STATUSES.includes(o.status));
  const proposalTotalByOpp = await listCurrentProposalTotalByOpp(
    open.map((o) => o.id)
  );

  const acc = new Map<string, PipelineStageRow>();
  for (const s of STAGE_ORDER) acc.set(s.status, { ...s, count: 0, bidCents: 0, weightedCents: 0, avgDealCents: 0, probabilityPct: null });

  let count = 0, bidCents = 0, weightedCents = 0;
  for (const o of open) {
    // Bucket by the board's COLUMN, so a deal reported under "Estimating"
    // is the same deal sitting in the Estimating column on screen.
    const row = acc.get(columnKeyForOpp(o.status, o.sub_status));
    if (!row) continue; // stage outside the open set (defensive)
    const fallback = proposalTotalByOpp.get(o.id);
    const bid = bidMidCents(o, fallback);
    const weighted = weightedPipelineCents(o, fallback);
    row.count += 1;
    row.bidCents += bid;
    row.weightedCents += weighted;
    count += 1;
    bidCents += bid;
    weightedCents += weighted;
  }

  const rows = STAGE_ORDER.map((s) => {
    const r = acc.get(s.status)!;
    r.avgDealCents = r.count > 0 ? Math.round(r.bidCents / r.count) : 0;
    r.probabilityPct = r.bidCents > 0 ? Math.round((r.weightedCents / r.bidCents) * 100) : null;
    return r;
  });

  return {
    rows,
    totals: {
      count,
      bidCents,
      weightedCents,
      avgDealCents: count > 0 ? Math.round(bidCents / count) : 0,
      probabilityPct: bidCents > 0 ? Math.round((weightedCents / bidCents) * 100) : null,
    },
  };
}

/** What this report returns when there is nothing to report. Exported so a page
 *  can degrade one card instead of failing whole. */
export const EMPTY_PIPELINE: PipelineReport = {
  rows: [],
  totals: { count: 0, bidCents: 0, weightedCents: 0, avgDealCents: 0, probabilityPct: null },
};
