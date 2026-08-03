import "server-only";

import {
  listCommercialOpportunities,
  weightedPipelineCents,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import { PRE_SALE_OPEN_STATUSES } from "@/lib/commercial/opportunities/constants";

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
};

export type PipelineReport = {
  rows: PipelineStageRow[];
  totals: { count: number; bidCents: number; weightedCents: number };
};

const STAGE_ORDER: { status: string; label: string }[] = [
  { status: "qualifying", label: "Qualifying" },
  { status: "estimating", label: "Estimating" },
  { status: "proposal", label: "Proposal out" },
];

/** Unweighted mid of the bid range in cents (0 when no range set). */
export function bidMidCents(o: CommercialOpportunity): number {
  const low = o.bid_value_low_cents;
  const high = o.bid_value_high_cents;
  if ((low === null || low === undefined) && (high === null || high === undefined)) return 0;
  if (low != null && high != null) return Math.round((low + high) / 2);
  return (low ?? high) ?? 0;
}

export async function getPipelineReport(): Promise<PipelineReport> {
  const opps = await listCommercialOpportunities({});
  const open = opps.filter((o) => PRE_SALE_OPEN_STATUSES.includes(o.status));

  const acc = new Map<string, PipelineStageRow>();
  for (const s of STAGE_ORDER) acc.set(s.status, { ...s, count: 0, bidCents: 0, weightedCents: 0 });

  const totals = { count: 0, bidCents: 0, weightedCents: 0 };
  for (const o of open) {
    const row = acc.get(o.status);
    if (!row) continue; // status outside the open-stage set (defensive)
    const bid = bidMidCents(o);
    const weighted = weightedPipelineCents(o);
    row.count += 1;
    row.bidCents += bid;
    row.weightedCents += weighted;
    totals.count += 1;
    totals.bidCents += bid;
    totals.weightedCents += weighted;
  }

  return { rows: STAGE_ORDER.map((s) => acc.get(s.status)!), totals };
}
