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

/**
 * Returns the UTC instant of midnight in America/New_York for the given
 * (year, monthIdx, day). PPP HQ is in NY and the convention across the
 * platform (see lib/salesforce/derive.ts) is to render periods in ET.
 *
 * Without this, a debrief recorded at 23:00 ET on Mar 31 stamps as
 * 03:00Z Apr 1 — which falls OUTSIDE a UTC-bounded Q1 query and gets
 * counted in Q2. Boundary debriefs were silently moving periods.
 *
 * Handles DST automatically by probing noon UTC of the target day to
 * read the ET offset that day (-5h EST winter, -4h EDT summer).
 */
function etMidnightToUTC(year: number, monthIdx: number, day: number): Date {
  const probe = new Date(Date.UTC(year, monthIdx, day, 12, 0, 0));
  // hour12:false + hour:"2-digit" gives "07" (EST) or "08" (EDT) when
  // we render noon UTC as NY local time. nyHour - 12 = the ET offset
  // for that calendar day.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  const nyHour = parseInt(fmt.format(probe), 10);
  const offsetHours = nyHour - 12; // -5 (EST) or -4 (EDT)
  return new Date(Date.UTC(year, monthIdx, day, -offsetHours));
}

/** Get "now" anchored as the calendar quarter in America/New_York. */
function nowInET(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { year: get("year"), month: get("month") - 1, day: get("day") };
}

/** Get the current quarter's date range (boundaries snapped to ET midnight). */
export function currentQuarterRange(): DateRange & { label: string } {
  const { year, month } = nowInET();
  const quarter = Math.floor(month / 3);
  const startMonth = quarter * 3;
  const endYear = startMonth + 3 >= 12 ? year + 1 : year;
  const endMonth = (startMonth + 3) % 12;
  const fromIso = etMidnightToUTC(year, startMonth, 1).toISOString();
  const toIso = etMidnightToUTC(endYear, endMonth, 1).toISOString();
  return { fromIso, toIso, label: `Q${quarter + 1} ${year}` };
}

/** Previous calendar quarter (Q4 prev year if we're in Q1). */
export function previousQuarterRange(): DateRange & { label: string } {
  const { year, month } = nowInET();
  const quarter = Math.floor(month / 3);
  const prevQuarter = quarter === 0 ? 3 : quarter - 1;
  const prevYear = quarter === 0 ? year - 1 : year;
  const startMonth = prevQuarter * 3;
  const endYear = startMonth + 3 >= 12 ? prevYear + 1 : prevYear;
  const endMonth = (startMonth + 3) % 12;
  const fromIso = etMidnightToUTC(prevYear, startMonth, 1).toISOString();
  const toIso = etMidnightToUTC(endYear, endMonth, 1).toISOString();
  return { fromIso, toIso, label: `Q${prevQuarter + 1} ${prevYear}` };
}

/** Current calendar year (Jan 1 ET → next Jan 1 ET). */
export function currentYearRange(): DateRange & { label: string } {
  const { year } = nowInET();
  const fromIso = etMidnightToUTC(year, 0, 1).toISOString();
  const toIso = etMidnightToUTC(year + 1, 0, 1).toISOString();
  return { fromIso, toIso, label: `${year}` };
}

/** Previous calendar year. */
export function previousYearRange(): DateRange & { label: string } {
  const { year: thisYear } = nowInET();
  const year = thisYear - 1;
  const fromIso = etMidnightToUTC(year, 0, 1).toISOString();
  const toIso = etMidnightToUTC(year + 1, 0, 1).toISOString();
  return { fromIso, toIso, label: `${year}` };
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
