import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Quarterly Win/Loss reports — drives `/commercial/reports/win-loss`.
 *
 * All queries scoped to a date range (defaults: current quarter). Filters
 * exposed: salesperson (TBD when team-role-scoping ships), date range.
 *
 * Numbers all derive from `commercial_win_loss_debrief` JOINed to
 * `commercial_opportunities` (for bid_value) and
 * `commercial_competitors` (for display names + merge resolution).
 *
 * Performance: indexes on (outcome, debriefed_at DESC), (competitor_id,
 * outcome, debriefed_at DESC) — so a typical "this quarter" filter is
 * a single index scan.
 */

export type DateRange = {
  fromIso: string; // inclusive, ISO string
  toIso: string;   // exclusive, ISO string
};

export type WinLossSummary = {
  totalClosed: number;
  wonCount: number;
  lostCount: number;
  noBidCount: number;
  wonValueCents: number;
  lostValueCents: number;
  winRatePct: number; // won / (won + lost), excludes no_bid
};

export type CompetitorBreakdown = {
  competitor_id: string | null;
  competitor_name: string; // "(unknown)" if null
  lost_count: number;
  won_count: number;
  total_count: number;
};

export type DecidingFactorBreakdown = {
  deciding_factor: string;
  count: number;
};

export type LessonRow = {
  debrief_id: string;
  opportunity_id: string;
  opportunity_title: string;
  outcome: "won" | "lost" | "no_bid";
  competitor_name: string | null;
  deciding_factor: string | null;
  lessons_learned: string;
  debriefed_at: string;
};

/** Get the current quarter's date range in UTC. */
export function currentQuarterRange(): DateRange & { label: string } {
  const now = new Date();
  const month = now.getUTCMonth(); // 0-11
  const quarter = Math.floor(month / 3); // 0-3
  const year = now.getUTCFullYear();
  const startMonth = quarter * 3;
  const fromIso = new Date(Date.UTC(year, startMonth, 1)).toISOString();
  // Exclusive end = first day of NEXT quarter
  const endYear = startMonth + 3 >= 12 ? year + 1 : year;
  const endMonth = (startMonth + 3) % 12;
  const toIso = new Date(Date.UTC(endYear, endMonth, 1)).toISOString();
  return { fromIso, toIso, label: `Q${quarter + 1} ${year}` };
}

/** Get summary KPIs for a date range. */
export async function getWinLossSummary(range: DateRange): Promise<WinLossSummary> {
  const sb = commercialDb();
  // Fetch all debriefs in the range with their opp bid values.
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select(`
      outcome,
      opportunity:commercial_opportunities!inner(bid_value_low_cents, bid_value_high_cents)
    `)
    .gte("debriefed_at", range.fromIso)
    .lt("debriefed_at", range.toIso);

  type Row = {
    outcome: "won" | "lost" | "no_bid";
    opportunity: { bid_value_low_cents: number | null; bid_value_high_cents: number | null }
      | Array<{ bid_value_low_cents: number | null; bid_value_high_cents: number | null }>
      | null;
  };

  let wonCount = 0;
  let lostCount = 0;
  let noBidCount = 0;
  let wonValueCents = 0;
  let lostValueCents = 0;
  for (const r of (data as unknown as Row[] | null) ?? []) {
    const opp = Array.isArray(r.opportunity) ? r.opportunity[0] ?? null : r.opportunity;
    const mid = midpointCents(opp?.bid_value_low_cents ?? null, opp?.bid_value_high_cents ?? null);
    if (r.outcome === "won") {
      wonCount++;
      wonValueCents += mid;
    } else if (r.outcome === "lost") {
      lostCount++;
      lostValueCents += mid;
    } else {
      noBidCount++;
    }
  }
  const decided = wonCount + lostCount;
  const winRatePct = decided > 0 ? Math.round((wonCount / decided) * 100) : 0;
  return {
    totalClosed: wonCount + lostCount + noBidCount,
    wonCount,
    lostCount,
    noBidCount,
    wonValueCents,
    lostValueCents,
    winRatePct,
  };
}

function midpointCents(low: number | null, high: number | null): number {
  if (low == null && high == null) return 0;
  if (low == null) return high ?? 0;
  if (high == null) return low;
  return Math.round((low + high) / 2);
}

/** Get competitor leaderboard for a date range. Top N by total debriefs. */
export async function getCompetitorBreakdown(
  range: DateRange,
  limit = 10
): Promise<CompetitorBreakdown[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select(`
      outcome,
      competitor_id,
      competitor:commercial_competitors!commercial_win_loss_debrief_competitor_id_fkey(name)
    `)
    .gte("debriefed_at", range.fromIso)
    .lt("debriefed_at", range.toIso);

  type Row = {
    outcome: "won" | "lost" | "no_bid";
    competitor_id: string | null;
    competitor: { name: string | null } | Array<{ name: string | null }> | null;
  };

  const byKey = new Map<string, CompetitorBreakdown>();
  for (const r of (data as unknown as Row[] | null) ?? []) {
    const c = Array.isArray(r.competitor) ? r.competitor[0] ?? null : r.competitor;
    const key = r.competitor_id ?? "(unknown)";
    const existing = byKey.get(key) ?? {
      competitor_id: r.competitor_id,
      competitor_name: c?.name ?? "(unknown)",
      lost_count: 0,
      won_count: 0,
      total_count: 0,
    };
    if (r.outcome === "lost") existing.lost_count++;
    else if (r.outcome === "won") existing.won_count++;
    existing.total_count++;
    byKey.set(key, existing);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.lost_count - a.lost_count || b.total_count - a.total_count)
    .slice(0, limit);
}

/** Get deciding-factor breakdown (lost + no_bid only — what's killing deals). */
export async function getDecidingFactorBreakdown(
  range: DateRange
): Promise<DecidingFactorBreakdown[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select("deciding_factor, outcome")
    .gte("debriefed_at", range.fromIso)
    .lt("debriefed_at", range.toIso)
    .in("outcome", ["lost", "no_bid"]);

  type Row = { deciding_factor: string | null };

  const counts = new Map<string, number>();
  for (const r of (data as Row[] | null) ?? []) {
    const factor = r.deciding_factor ?? "(unspecified)";
    counts.set(factor, (counts.get(factor) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([deciding_factor, count]) => ({ deciding_factor, count }))
    .sort((a, b) => b.count - a.count);
}

/** Get the "what would we do differently" feed — most recent first. */
export async function getLessonsLearnedFeed(
  range: DateRange,
  limit = 20
): Promise<LessonRow[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select(`
      id,
      opportunity_id,
      outcome,
      deciding_factor,
      lessons_learned,
      debriefed_at,
      opportunity:commercial_opportunities!inner(title),
      competitor:commercial_competitors!commercial_win_loss_debrief_competitor_id_fkey(name)
    `)
    .gte("debriefed_at", range.fromIso)
    .lt("debriefed_at", range.toIso)
    .not("lessons_learned", "is", null)
    .order("debriefed_at", { ascending: false })
    .limit(limit);

  type Row = {
    id: string;
    opportunity_id: string;
    outcome: "won" | "lost" | "no_bid";
    deciding_factor: string | null;
    lessons_learned: string | null;
    debriefed_at: string;
    opportunity: { title: string | null } | Array<{ title: string | null }> | null;
    competitor: { name: string | null } | Array<{ name: string | null }> | null;
  };

  return ((data as unknown as Row[] | null) ?? [])
    .filter((r) => r.lessons_learned && r.lessons_learned.trim().length > 0)
    .map((r) => {
      const opp = Array.isArray(r.opportunity) ? r.opportunity[0] ?? null : r.opportunity;
      const c = Array.isArray(r.competitor) ? r.competitor[0] ?? null : r.competitor;
      return {
        debrief_id: r.id,
        opportunity_id: r.opportunity_id,
        opportunity_title: opp?.title ?? "(untitled)",
        outcome: r.outcome,
        competitor_name: c?.name ?? null,
        deciding_factor: r.deciding_factor,
        lessons_learned: r.lessons_learned!,
        debriefed_at: r.debriefed_at,
      };
    });
}
