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
export function etMidnightToUTC(year: number, monthIdx: number, day: number): Date {
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
  // D1: ONE win rate — won / (won + lost) over DECIDED DEALS by `decided_at`,
  // not debrief-gated.
  //
  // This read debrief ROWS by `debriefed_at`. Three things differed from the
  // dashboard tile that links here: the source (a debrief row, not the deal),
  // the date field, and the period. The worst was the gating — a win with no
  // debrief filed yet is IN the dashboard tile and was OUT of this report, so
  // the deals the dashboard flags as "awaiting debrief" were exactly the ones
  // missing from the report it sends you to. Filing paperwork changed the win
  // rate.
  //
  // Deals are the source of truth for what was won and lost. Debriefs stay the
  // source for WHY — the competitor and deciding-factor breakdowns below still
  // read them, which is what they are actually for.
  // A WIN stays won as it moves into delivery — pre-construction, in progress,
  // billing, closed out. Scoping this to `pre_sale_closed` counted only wins
  // that had not been started yet, while the dashboard tile counts them at any
  // stage, so tapping "5 wins · 62%" landed on a report showing 1. Losses only
  // ever sit in pre_sale_closed, so they need no equivalent.
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, status, sub_status, loss_reason, bid_value_low_cents, bid_value_high_cents, decided_at, accepted_contract_cents")
    .in("status", [
      "pre_sale_closed",
      "pre_construction",
      "in_progress",
      "billing",
      "post_sale_closed",
    ])
    .is("deleted_at", null)
    .is("archived_at", null)
    .not("decided_at", "is", null)
    .gte("decided_at", range.fromIso.slice(0, 10))
    .lt("decided_at", range.toIso.slice(0, 10));

  type Row = {
    id: string;
    status: string;
    sub_status: string | null;
    loss_reason: string | null;
    bid_value_low_cents: number | null;
    bid_value_high_cents: number | null;
    accepted_contract_cents: number | null;
  };
  const rows = ((data as Row[] | null) ?? []);

  let wonCount = 0;
  let lostCount = 0;
  let noBidCount = 0;
  let wonValueCents = 0;
  let lostValueCents = 0;

  // The 2026-08 meeting removed Bid low/high from every opportunity form —
  // pricing lives on the proposal now — so a deal created since then has NO bid
  // range and midpointCents returns 0. Without the proposal fallback, "Won $"
  // reads zero for exactly the deals the team is creating today.
  const { listCurrentProposalTotalByOpp } = await import("@/lib/commercial/proposals/db");
  const proposalTotalByOpp = await listCurrentProposalTotalByOpp(rows.map((r) => r.id));

  for (const r of rows) {
    // Value a WON deal at the signed contract when there is one. The bid
    // midpoint is an estimate made before the job was priced — and since bid
    // low/high were pulled from the opportunity forms, most deals have none at
    // all, so "Won $" fell back to a proposal total and never reflected what
    // Tomco actually agreed to. A signed number beats a guess.
    const mid =
      (Number(r.accepted_contract_cents) || 0) ||
      midpointCents(r.bid_value_low_cents, r.bid_value_high_cents) ||
      (proposalTotalByOpp.get(r.id) ?? 0);
    // Won = decided won at any stage. `isPostSaleProject` in SQL terms: a
    // delivery status, or pre_sale_closed with sub_status won.
    if (r.status !== "pre_sale_closed" || r.sub_status === "won") {
      wonCount++;
      wonValueCents += mid;
    } else if (r.loss_reason === "no_bid") {
      // A no-bid is not a loss — we never quoted it, so it is excluded from the
      // rate rather than counted against it.
      noBidCount++;
    } else {
      lostCount++;
      lostValueCents += mid;
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
      opportunity:commercial_opportunities!commercial_win_loss_debrief_opportunity_id_fkey!inner(title, deleted_at),
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
    opportunity: { title: string | null; deleted_at: string | null } | Array<{ title: string | null; deleted_at: string | null }> | null;
    competitor: { name: string | null } | Array<{ name: string | null }> | null;
  };

  const oppOf = (r: Row) => (Array.isArray(r.opportunity) ? r.opportunity[0] ?? null : r.opportunity);
  return ((data as unknown as Row[] | null) ?? [])
    .filter((r) => !oppOf(r)?.deleted_at) // drop lessons whose opp was soft-deleted
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
