import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { etDateOf } from "@/lib/date-et";
import { columnKeyForOpp } from "@/lib/commercial/opportunities/kanban-columns";
import { POST_SALE_STATUSES } from "@/lib/commercial/opportunities/constants";

/**
 * Estimator / proposal performance — "how is Kim doing".
 *
 * Five decisions decide whether these numbers are trustworthy, so they are
 * stated here rather than buried:
 *
 * 1. **A bid is a DEAL, not a proposal row.** Someone who revises five times
 *    has sent one bid, not five. Counting rows would make the most careful
 *    estimator look the busiest.
 *
 * 2. **The period is keyed on when the bid WENT OUT**, not when the deal was
 *    created. "How did July go" means the bids sent in July, whatever month
 *    the GC first called. A deal opened in March and sent in July is July's.
 *
 * 3. **Turnaround uses the FIRST send**, not the latest. A revision in
 *    October doesn't mean that bid took four months. Deals with no
 *    `rfp_received_at` are excluded from the average rather than counted as
 *    zero — an unknown is not a fast turnaround.
 *
 * 4. **Win rate counts DECIDED bids only** (won + lost). An open bid is not a
 *    loss yet. Including opens drags every rate down and makes the number move
 *    when nothing has happened.
 *
 * 5. **Unassigned bids are shown, never dropped.** A bid with no estimator is
 *    the one most likely to be forgotten, so hiding it would defeat the report.
 *
 * Admin-gated at the page, not here: this is per-person performance data.
 */

export type EstimatorRow = {
  key: string;
  name: string;
  /** Deals with at least one proposal sent in the period. */
  bidsSent: number;
  bidValueCents: number;
  won: number;
  lost: number;
  /** Still out with the GC — not counted against the win rate. */
  open: number;
  wonValueCents: number;
  /** won ÷ (won + lost), or null when nothing has been decided yet. */
  winRatePct: number | null;
  /** Mean days from RFP received to first send, over bids where both dates
   *  exist. Null when none do. */
  avgTurnaroundDays: number | null;
  /** How many of this person's bids could be measured — the honesty figure
   *  behind the average above. */
  turnaroundSample: number;
};

export type EstimatorReport = {
  rows: EstimatorRow[];
  totals: {
    bidsSent: number;
    bidValueCents: number;
    won: number;
    lost: number;
    open: number;
    wonValueCents: number;
    winRatePct: number | null;
    avgTurnaroundDays: number | null;
    turnaroundSample: number;
  };
  /** Bids missing an RFP-received date, so turnaround can't be measured. */
  missingRfpDate: number;
  /** Bids whose first send predates the RFP arriving — a data-entry error, not
   *  a negative turnaround. Excluded from the average and surfaced. */
  sentBeforeRfp: number;
};

const EMPTY: EstimatorReport = {
  rows: [],
  totals: { bidsSent: 0, bidValueCents: 0, won: 0, lost: 0, open: 0, wonValueCents: 0, winRatePct: null, avgTurnaroundDays: null, turnaroundSample: 0 },
  missingRfpDate: 0,
  sentBeforeRfp: 0,
};

/** Whole days between two ET calendar dates. */
function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

const UNASSIGNED = "__unassigned__";

export async function getEstimatorReport(range: {
  fromYmd: string;
  toYmd: string;
}): Promise<EstimatorReport> {
  const sb = commercialDb();

  // Every proposal that has actually gone out. `superseded` and `expired` are
  // states a sent proposal can END in, so they are included when they carry a
  // send date — the bid was still sent. A draft that never left is not a bid.
  const proposals = await paginateAll<{
    opportunity_id: string;
    revision_number: number;
    total_cents: number;
    status: string;
    sent_at: string | null;
  }>(() =>
    sb
      .from("commercial_proposals")
      .select("opportunity_id, revision_number, total_cents, status, sent_at")
      .not("sent_at", "is", null)
      .is("deleted_at", null)
      .order("opportunity_id")
      .order("revision_number")
  );
  if (proposals.length === 0) return EMPTY;

  // Fold to ONE row per deal: earliest send (for turnaround) and the value of
  // the newest sent revision (what the GC is actually holding).
  type Bid = { firstSentYmd: string; latestRev: number; valueCents: number };
  const bidByOpp = new Map<string, Bid>();
  for (const p of proposals) {
    const ymd = etDateOf(p.sent_at);
    if (!ymd) continue;
    const cur = bidByOpp.get(p.opportunity_id);
    if (!cur) {
      bidByOpp.set(p.opportunity_id, { firstSentYmd: ymd, latestRev: p.revision_number, valueCents: p.total_cents ?? 0 });
      continue;
    }
    if (ymd < cur.firstSentYmd) cur.firstSentYmd = ymd;
    if (p.revision_number >= cur.latestRev) {
      cur.latestRev = p.revision_number;
      cur.valueCents = p.total_cents ?? 0;
    }
  }

  // The period is keyed on the FIRST send — see decision 2.
  const inPeriod = [...bidByOpp.entries()].filter(
    ([, b]) => b.firstSentYmd >= range.fromYmd && b.firstSentYmd <= range.toYmd
  );
  if (inPeriod.length === 0) return EMPTY;

  const oppIds = inPeriod.map(([id]) => id);
  const opps = await paginateAll<{
    id: string;
    estimator_user_id: string | null;
    estimator_name: string | null;
    rfp_received_at: string | null;
    status: string;
    sub_status: string | null;
  }>(() =>
    sb
      .from("commercial_opportunities")
      .select("id, estimator_user_id, estimator_name, rfp_received_at, status, sub_status")
      .in("id", oppIds)
      .is("deleted_at", null)
  );
  const oppById = new Map(opps.map((o) => [o.id, o]));

  // Names. `estimator_name` is free text captured when no user was picked, so
  // it is the fallback rather than the source — two people typing the same
  // name differently would otherwise split into two rows.
  const userIds = [...new Set(opps.map((o) => o.estimator_user_id).filter(Boolean))] as string[];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data } = await sb
      .from("profiles")
      .select("user_id, full_name, sf_user_name, email")
      .in("user_id", userIds);
    for (const p of (data ?? []) as { user_id: string; full_name: string | null; sf_user_name: string | null; email: string | null }[]) {
      nameById.set(p.user_id, (p.full_name || p.sf_user_name || p.email || "Unknown").trim());
    }
  }

  const acc = new Map<string, EstimatorRow & { turnaroundTotal: number }>();
  let missingRfpDate = 0;
  let sentBeforeRfp = 0;

  for (const [oppId, bid] of inPeriod) {
    const opp = oppById.get(oppId);
    if (!opp) continue; // deleted deal — its bid isn't anyone's score

    const key = opp.estimator_user_id ?? UNASSIGNED;
    const name =
      (opp.estimator_user_id && nameById.get(opp.estimator_user_id)) ||
      opp.estimator_name?.trim() ||
      (opp.estimator_user_id ? "Unknown user" : "Unassigned");

    const row = acc.get(key) ?? {
      key,
      name,
      bidsSent: 0,
      bidValueCents: 0,
      won: 0,
      lost: 0,
      open: 0,
      wonValueCents: 0,
      winRatePct: null,
      avgTurnaroundDays: null,
      turnaroundSample: 0,
      turnaroundTotal: 0,
    };

    row.bidsSent += 1;
    row.bidValueCents += bid.valueCents;

    // Outcome from the DEAL, which is the record of record — a proposal left
    // in 'sent' on a deal marked Won would otherwise never count as a win.
    //
    // Via `columnKeyForOpp`, the one mapper the board, the filters and the
    // reports all use. Writing the tuple test out again here is how the same
    // deal ends up won on one screen and open on another — and this file would
    // have disagreed with the board on a junk sub-status, which the board
    // deliberately reads as Lost so it can never inflate the won column.
    const column = columnKeyForOpp(opp.status, opp.sub_status);
    const inDelivery = (POST_SALE_STATUSES as readonly string[]).includes(opp.status);
    if (column === "won" || inDelivery) {
      row.won += 1;
      row.wonValueCents += bid.valueCents;
    } else if (column === "lost") {
      row.lost += 1;
    } else {
      row.open += 1;
    }

    const rfp = etDateOf(opp.rfp_received_at);
    if (!rfp) {
      missingRfpDate += 1;
    } else {
      const days = daysBetween(rfp, bid.firstSentYmd);
      if (days < 0) {
        // Sent before the plans arrived. That is a typo, not a fast bid, and
        // averaging it in would quietly pull everyone's number down.
        sentBeforeRfp += 1;
      } else {
        row.turnaroundTotal += days;
        row.turnaroundSample += 1;
      }
    }

    acc.set(key, row);
  }

  const finish = (r: EstimatorRow & { turnaroundTotal: number }): EstimatorRow => {
    const decided = r.won + r.lost;
    const { turnaroundTotal, ...rest } = r;
    return {
      ...rest,
      winRatePct: decided > 0 ? Math.round((r.won / decided) * 100) : null,
      avgTurnaroundDays: r.turnaroundSample > 0 ? Math.round(turnaroundTotal / r.turnaroundSample) : null,
    };
  };

  const rows = [...acc.values()]
    .map(finish)
    // Most bids first. Unassigned sinks to the bottom regardless — it is a
    // data-hygiene row, not a person to rank.
    .sort((a, b) => {
      if ((a.key === UNASSIGNED) !== (b.key === UNASSIGNED)) return a.key === UNASSIGNED ? 1 : -1;
      return b.bidsSent - a.bidsSent || b.wonValueCents - a.wonValueCents;
    });

  const sum = (f: (r: EstimatorRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const totalDecided = sum((r) => r.won) + sum((r) => r.lost);
  const totalSample = sum((r) => r.turnaroundSample);
  // Re-derive from the per-row totals so the footer can't disagree with the
  // column above it.
  const weightedTurnaround = rows.reduce(
    (n, r) => n + (r.avgTurnaroundDays ?? 0) * r.turnaroundSample,
    0
  );

  return {
    rows,
    totals: {
      bidsSent: sum((r) => r.bidsSent),
      bidValueCents: sum((r) => r.bidValueCents),
      won: sum((r) => r.won),
      lost: sum((r) => r.lost),
      open: sum((r) => r.open),
      wonValueCents: sum((r) => r.wonValueCents),
      winRatePct: totalDecided > 0 ? Math.round((sum((r) => r.won) / totalDecided) * 100) : null,
      avgTurnaroundDays: totalSample > 0 ? Math.round(weightedTurnaround / totalSample) : null,
      turnaroundSample: totalSample,
    },
    missingRfpDate,
    sentBeforeRfp,
  };
}
