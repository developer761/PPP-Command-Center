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
/**
 * Every decided deal in the window, one row each.
 *
 * Karan 2026-09-16: Win/Loss was the last report with no records on it. The
 * gauge said 38% and the donut split the dollars, and nothing on the page said
 * WHICH deals — so it could be read but never worked, and with no table there
 * was no Export either.
 *
 * The summary below is folded FROM these rows rather than counted separately.
 * That is the whole point of the refactor: two queries classifying "won" the
 * same way is a promise, and this file already carries three comments about
 * surfaces that drifted apart on exactly that question. Now a table row and a
 * tick on the gauge are the same object, and they cannot disagree.
 */
export type WinLossRecord = {
  oppId: string;
  name: string;
  accountName: string;
  outcome: "won" | "lost" | "no_bid";
  /** Signed contract where there is one, else the bid midpoint, else proposal. */
  valueCents: number;
  decidedYmd: string | null;
  /** Why it was lost, in Tomco's words. Null on a win. */
  lossReason: string | null;
  /** From the debrief, when one has been filed. */
  competitor: string | null;
  decidingFactor: string | null;
};

export async function getWinLossRecords(range: DateRange): Promise<WinLossRecord[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title, client_name, title_override, title_override_mode, property_street, property_city, status, sub_status, loss_reason, bid_value_low_cents, bid_value_high_cents, decided_at, closed_out_at, accepted_contract_cents")
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
    account_id: string;
    title: string | null;
    client_name: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    property_street: string | null;
    property_city: string | null;
    status: string;
    sub_status: string | null;
    loss_reason: string | null;
    bid_value_low_cents: number | null;
    bid_value_high_cents: number | null;
    decided_at: string | null;
    closed_out_at: string | null;
    accepted_contract_cents: number | null;
  };
  const rows = ((data as Row[] | null) ?? []).filter(
    // Match wasWonInPeriod (the dashboard "wins" tile that links here): a
    // post_sale_closed row with a null closed_out_at is a legacy close-out whose
    // decided_at records the CLOSE-OUT, not the win, so the tile excludes it.
    // The report must exclude it too, or tapping "5 wins · 62%" lands on a list
    // that counts a different set (audit D9).
    (r) => !(r.status === "post_sale_closed" && !r.closed_out_at)
  );
  if (rows.length === 0) return [];

  // The 2026-08 meeting removed Bid low/high from every opportunity form —
  // pricing lives on the proposal now — so a deal created since then has NO bid
  // range and midpointCents returns 0. Without the proposal fallback, "Won $"
  // reads zero for exactly the deals the team is creating today.
  const { listCurrentProposalTotalByOpp } = await import("@/lib/commercial/proposals/db");
  const { derivedOppName, opportunityLossReasonLabel } = await import("@/lib/commercial/opportunities/db");
  const proposalTotalByOpp = await listCurrentProposalTotalByOpp(rows.map((r) => r.id));

  const { data: accounts } = await sb
    .from("commercial_accounts")
    .select("id, company_name")
    .in("id", [...new Set(rows.map((r) => r.account_id))]);
  const acct = new Map(((accounts ?? []) as { id: string; company_name: string | null }[]).map((a) => [a.id, a.company_name]));

  // The debrief carries WHY. It is optional — a deal decided last week may have
  // none — so this is a left join in spirit: a missing debrief leaves the two
  // columns blank rather than dropping the deal off the report.
  const { data: debriefs } = await sb
    .from("commercial_win_loss_debrief")
    .select("opportunity_id, deciding_factor, competitor:commercial_competitors!commercial_win_loss_debrief_competitor_id_fkey(name)")
    .in("opportunity_id", rows.map((r) => r.id));
  type DebriefRow = {
    opportunity_id: string;
    deciding_factor: string | null;
    competitor: { name: string | null } | Array<{ name: string | null }> | null;
  };
  const debriefByOpp = new Map<string, { competitor: string | null; decidingFactor: string | null }>();
  for (const d of ((debriefs as unknown as DebriefRow[] | null) ?? [])) {
    const c = Array.isArray(d.competitor) ? d.competitor[0] ?? null : d.competitor;
    debriefByOpp.set(d.opportunity_id, {
      competitor: c?.name ?? null,
      decidingFactor: d.deciding_factor ?? null,
    });
  }

  return rows
    .map((r) => {
      // Value a WON deal at the signed contract when there is one. The bid
      // midpoint is an estimate made before the job was priced — and since bid
      // low/high were pulled from the opportunity forms, most deals have none at
      // all, so "Won $" fell back to a proposal total and never reflected what
      // Tomco actually agreed to. A signed number beats a guess.
      const valueCents =
        (Number(r.accepted_contract_cents) || 0) ||
        midpointCents(r.bid_value_low_cents, r.bid_value_high_cents) ||
        (proposalTotalByOpp.get(r.id) ?? 0);
      // Won = decided won at any stage. `isPostSaleProject` in SQL terms: a
      // delivery status, or pre_sale_closed with sub_status won.
      const outcome: WinLossRecord["outcome"] =
        r.status !== "pre_sale_closed" || r.sub_status === "won"
          ? "won"
          : r.loss_reason === "no_bid"
            ? "no_bid"
            : "lost";
      const d = debriefByOpp.get(r.id);
      return {
        oppId: r.id,
        name: derivedOppName({ ...r, title: r.title ?? "" }, acct.get(r.account_id) ?? null),
        accountName: (acct.get(r.account_id) ?? "").trim() || "Unassigned account",
        outcome,
        // A no-bid was never quoted, so it carries no value on this report —
        // showing the estimate would put money against a job nobody priced.
        valueCents: outcome === "no_bid" ? 0 : valueCents,
        decidedYmd: r.decided_at ? String(r.decided_at).slice(0, 10) : null,
        lossReason:
          outcome === "won" || !r.loss_reason
            ? null
            : opportunityLossReasonLabel(r.loss_reason as Parameters<typeof opportunityLossReasonLabel>[0]),
        competitor: d?.competitor ?? null,
        decidingFactor: d?.decidingFactor ?? null,
      };
    })
    .sort((a, b) => (b.decidedYmd ?? "").localeCompare(a.decidedYmd ?? "") || b.valueCents - a.valueCents);
}

/** The headline figures, folded from the records so the two cannot disagree. */
export function summarizeWinLoss(records: WinLossRecord[]): WinLossSummary {
  let wonCount = 0, lostCount = 0, noBidCount = 0, wonValueCents = 0, lostValueCents = 0;
  for (const r of records) {
    if (r.outcome === "won") {
      wonCount++;
      wonValueCents += r.valueCents;
    } else if (r.outcome === "no_bid") {
      // A no-bid is not a loss — we never quoted it, so it is excluded from the
      // rate rather than counted against it.
      noBidCount++;
    } else {
      lostCount++;
      lostValueCents += r.valueCents;
    }
  }
  const decided = wonCount + lostCount;
  return {
    totalClosed: wonCount + lostCount + noBidCount,
    wonCount,
    lostCount,
    noBidCount,
    wonValueCents,
    lostValueCents,
    winRatePct: decided > 0 ? Math.round((wonCount / decided) * 100) : 0,
  };
}

export async function getWinLossSummary(range: DateRange): Promise<WinLossSummary> {
  return summarizeWinLoss(await getWinLossRecords(range));
}

/**
 * Is there anything to compare against — did we both win and lose?
 *
 * Both headline ratios on the Win/Loss report are meaningless without it, and
 * they are meaningless in DIFFERENT directions, which is how the bug got in.
 * With wins on record and no losses, "win rate" correctly printed "—" while
 * "$ won ratio", guarded only against a zero denominator, printed a confident
 * 100% "of every $ we bid on" — off the same rows, side by side. The live
 * report said exactly that on 2026-09-25: 12 won, none lost, and a clean
 * sweep in the second tile.
 *
 * One predicate, used by both, so they cannot disagree again.
 */
export function hadHeadToHead(s: Pick<WinLossSummary, "wonCount" | "lostCount">): boolean {
  return s.wonCount > 0 && s.lostCount > 0;
}

/**
 * Share of bid DOLLARS won, or null when there is nothing to compare against.
 *
 * Null rather than 0 or 100: "we have no record of losing" is not a result,
 * and a tile is the wrong place to guess. The caller renders "—".
 */
export function wonValueRatioPct(
  s: Pick<WinLossSummary, "wonCount" | "lostCount" | "wonValueCents" | "lostValueCents">,
): number | null {
  if (!hadHeadToHead(s)) return null;
  const total = s.wonValueCents + s.lostValueCents;
  // Both sides have records but both are valued at zero — real for unpriced
  // bids. A percentage of nothing is still not an answer.
  if (total === 0) return null;
  return Math.round((s.wonValueCents / total) * 100);
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

export type AwaitingDebriefRow = {
  id: string;
  account_id: string;
  label: string;
  decided_at: string | null;
};

/**
 * Won opportunities that still need a debrief — the actual work-list behind the
 * dashboard's "Awaiting debrief" card. The card linked to this report but the
 * report only showed filed debriefs, so there was nothing to act on (audit N19).
 * Scoped exactly like the dashboard count: pre_sale_closed + won + no
 * win_loss_debriefed_at (the only state a debrief can be filed from).
 */
export async function getWinsAwaitingDebrief(limit = 50): Promise<AwaitingDebriefRow[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title, title_override, title_override_mode, client_name, property_street, decided_at, account:commercial_accounts!inner(company_name, deleted_at)")
    .eq("status", "pre_sale_closed")
    .eq("sub_status", "won")
    .is("win_loss_debriefed_at", null)
    .is("deleted_at", null)
    .is("archived_at", null)
    .is("account.deleted_at", null)
    .order("decided_at", { ascending: false })
    .limit(limit);
  type Row = {
    id: string;
    account_id: string;
    title: string | null;
    title_override: string | null;
    title_override_mode: string | null;
    client_name: string | null;
    property_street: string | null;
    decided_at: string | null;
    account: { company_name: string | null } | Array<{ company_name: string | null }> | null;
  };
  const { derivedOppName } = await import("@/lib/commercial/opportunities/db");
  return ((data as unknown as Row[] | null) ?? []).map((o) => {
    const acct = Array.isArray(o.account) ? o.account[0] ?? null : o.account;
    return {
      id: o.id,
      account_id: o.account_id,
      // Not `title_override || title` — that ignores the nickname toggle and
      // names the deal after the shorthand alone. derivedOppName is the one
      // definition of what a deal is called.
      label:
        derivedOppName({ ...o, title: o.title ?? "" }, acct?.company_name ?? null).trim() ||
        (o.client_name || o.property_street || acct?.company_name || "Untitled deal").trim(),
      decided_at: o.decided_at,
    };
  });
}

/** What this summary returns when nothing has closed. Exported so a page can
 *  degrade one card instead of failing whole. */
export const EMPTY_WIN_LOSS: WinLossSummary = {
  totalClosed: 0,
  wonCount: 0,
  lostCount: 0,
  noBidCount: 0,
  wonValueCents: 0,
  lostValueCents: 0,
  winRatePct: 0,
};
