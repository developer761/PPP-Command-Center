import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * Competitor dictionary — fuels the Win/Loss Debrief modal's typeahead.
 *
 * Design notes:
 *   - `name_normalized` is a UNIQUE lowercase-trimmed lookup key so
 *     "ABC Painting" / "abc painters" / "  ABC Painting  " all collapse
 *     to one row. Stored alongside the human-readable `name` (title-cased).
 *   - `is_active` lets admins retire competitors without deleting (preserves
 *     historic debrief rows that FK to this table).
 *   - `merged_into_competitor_id` is the merge tombstone — debrief queries
 *     follow this chain so reports roll up correctly after a merge.
 *
 * Auto-create on first reference: when a user types "Bob's Painting" in
 * the debrief modal and there's no match, the modal can call
 * `getOrCreateCompetitor` instead of asking them to go to the admin page
 * first. New rows are created with author_user_id = the debrief submitter
 * so we can track who introduced each competitor name.
 */

export type Competitor = {
  id: string;
  name: string;
  name_normalized: string;
  is_active: boolean;
  created_at: string;
  created_by_user_id: string | null;
  updated_at: string;
  merged_into_competitor_id: string | null;
};

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Title-case the input for display ("abc painting" → "Abc Painting").
 *  Preserves words that already have internal casing ("PPP" stays "PPP"). */
function displayName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed
    .split(" ")
    .map((w) => {
      // Already has internal uppercase? leave alone.
      if (w.length > 1 && /[A-Z]/.test(w.slice(1))) return w;
      // All upper short word (acronyms like ABC, PPP, LLC) — leave alone.
      if (w === w.toUpperCase() && w.length <= 4) return w;
      // Standard title-case.
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * Lookup-or-create a competitor by name. Returns the existing row if the
 * normalized name matches. Follows merge chains so a merged competitor
 * returns the survivor.
 */
export async function getOrCreateCompetitor(
  rawName: string,
  createdByUserId: string | null
): Promise<{ ok: true; competitor: Competitor } | { ok: false; error: string }> {
  const display = displayName(rawName);
  const normalized = normalizeName(rawName);
  if (!normalized) return { ok: false, error: "Competitor name is empty." };
  if (normalized.length > 200) {
    return { ok: false, error: "Competitor name is too long (max 200 chars)." };
  }

  const sb = commercialDb();

  // First try lookup. If there's a merge chain, follow it.
  const existing = await findCompetitorByNormalized(normalized);
  if (existing) {
    return { ok: true, competitor: await followMergeChain(existing) };
  }

  // Insert with conflict-do-nothing to handle two-callers-race (two users
  // both adding "Bob's Painting" simultaneously). On conflict, re-select.
  const { data: inserted, error } = await sb
    .from("commercial_competitors")
    .insert({
      name: display,
      name_normalized: normalized,
      created_by_user_id: createdByUserId,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    // Only treat Postgres UNIQUE violation (23505) as a retryable race.
    // Anything else (permission denied, schema error, etc) bubbles up
    // — the old code silently re-selected on ANY error which masked
    // real bugs as "competitor not found."
    const isUniqueViolation = error.code === "23505";
    if (isUniqueViolation) {
      const after = await findCompetitorByNormalized(normalized);
      if (after) return { ok: true, competitor: await followMergeChain(after) };
    }
    return { ok: false, error: error.message };
  }
  if (!inserted) return { ok: false, error: "Failed to create competitor." };
  const row = inserted as Competitor;
  await logInsert("commercial_competitors", row.id, row, createdByUserId);
  return { ok: true, competitor: row };
}

async function findCompetitorByNormalized(normalized: string): Promise<Competitor | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("name_normalized", normalized)
    .maybeSingle();
  return (data as Competitor | null) ?? null;
}

async function followMergeChain(start: Competitor, depth = 0): Promise<Competitor> {
  // Bound the loop so a circular merge (operator error) can't hang.
  // At depth 4 we're already 4 merges deep — warn so an admin can
  // collapse the chain manually. At depth 6 we stop walking + return
  // what we have (the deepest in-chain row we've seen so far).
  if (depth >= 4) {
    console.warn(
      `[commercial_competitors] merge chain at depth ${depth} starting from ${start.id} (${start.name}). ` +
        `Consider collapsing the chain in /commercial/settings/competitors so reports roll up correctly.`
    );
  }
  if (depth > 5) return start;
  if (!start.merged_into_competitor_id) return start;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("id", start.merged_into_competitor_id)
    .maybeSingle();
  const next = data as Competitor | null;
  if (!next) return start;
  return followMergeChain(next, depth + 1);
}

/**
 * Typeahead query — used by the debrief modal's combobox. Returns active
 * competitors ranked by:
 *   1. exact normalized match first
 *   2. prefix match next
 *   3. substring match last
 * Capped at 20 to keep the dropdown small.
 */
export async function searchCompetitors(query: string): Promise<Competitor[]> {
  const normalized = normalizeName(query);
  if (!normalized) {
    // Empty query — return the 20 most-recently-seen active competitors.
    const sb = commercialDb();
    const { data } = await sb
      .from("commercial_competitors")
      .select("*")
      .eq("is_active", true)
      .is("merged_into_competitor_id", null)
      .order("updated_at", { ascending: false })
      .limit(20);
    return (data as Competitor[] | null) ?? [];
  }

  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("is_active", true)
    .is("merged_into_competitor_id", null)
    .ilike("name_normalized", `%${normalized.replace(/[%_]/g, "")}%`)
    .limit(20);

  const rows = (data as Competitor[] | null) ?? [];
  // Rank: exact → prefix → substring → other.
  return rows.sort((a, b) => {
    const aRank = a.name_normalized === normalized
      ? 0
      : a.name_normalized.startsWith(normalized)
      ? 1
      : 2;
    const bRank = b.name_normalized === normalized
      ? 0
      : b.name_normalized.startsWith(normalized)
      ? 1
      : 2;
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Admin-only: merge one competitor INTO another. Sets the merge tombstone
 * on the source so historic debriefs roll up to the target via the merge
 * chain follower above.
 */
export async function mergeCompetitor(
  sourceId: string,
  targetId: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (sourceId === targetId) return { ok: false, error: "Cannot merge into self." };
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("id", sourceId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Source competitor not found." };
  const { data: target } = await sb
    .from("commercial_competitors")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  if (!target) return { ok: false, error: "Target competitor not found." };

  const { error } = await sb
    .from("commercial_competitors")
    .update({ merged_into_competitor_id: targetId, is_active: false })
    .eq("id", sourceId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_competitors",
    sourceId,
    before,
    { ...(before as object), merged_into_competitor_id: targetId, is_active: false },
    actorUserId
  );
  return { ok: true };
}

/** Admin-only: toggle active/inactive (retire without merging). */
export async function setCompetitorActive(
  competitorId: string,
  isActive: boolean,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("id", competitorId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Competitor not found." };
  const { error } = await sb
    .from("commercial_competitors")
    .update({ is_active: isActive })
    .eq("id", competitorId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_competitors",
    competitorId,
    before,
    { ...(before as object), is_active: isActive },
    actorUserId
  );
  return { ok: true };
}

/** Admin-only: rename. Updates display name + recomputes normalized. */
export async function renameCompetitor(
  competitorId: string,
  newName: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const display = displayName(newName);
  const normalized = normalizeName(newName);
  if (!normalized) return { ok: false, error: "Name cannot be empty." };
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_competitors")
    .select("*")
    .eq("id", competitorId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Competitor not found." };
  const { error } = await sb
    .from("commercial_competitors")
    .update({ name: display, name_normalized: normalized })
    .eq("id", competitorId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_competitors",
    competitorId,
    before,
    { ...(before as object), name: display, name_normalized: normalized },
    actorUserId
  );
  return { ok: true };
}

/** List all competitors for the admin management page. Includes merged + inactive. */
export async function listAllCompetitors(): Promise<Competitor[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_competitors")
    .select("*")
    .order("name", { ascending: true });
  return (data as Competitor[] | null) ?? [];
}

/**
 * Karan 2026-07-09: lifetime debrief stats per competitor for the
 * Competitors settings page. Turns the page from a plain dictionary
 * editor into a real competitor intelligence view — you see who you
 * lose to most, your win rate against each, and when they last
 * showed up on a deal.
 *
 * Returns a Map keyed on competitor_id so the calling page can join
 * against `listAllCompetitors()` without a second round-trip.
 */
export type CompetitorLifetimeStats = {
  won_count: number;
  lost_count: number;
  no_bid_count: number;
  total_count: number;
  last_seen_at: string | null;
  win_rate_pct: number | null;
  /** Sum of midpoint bid $ (in cents) on LOST debriefs — how much
   *  business this competitor has taken from us over time. */
  dollar_lost_cents: number;
  /** Most-common deciding_factor tag on lost debriefs against this
   *  competitor — the "why" behind the losses. Null if there's no
   *  loss data or no factor recorded. */
  top_deciding_factor: string | null;
};

export async function getLifetimeCompetitorStats(): Promise<Map<string, CompetitorLifetimeStats>> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_win_loss_debrief")
    .select(`
      competitor_id,
      outcome,
      debriefed_at,
      deciding_factor,
      opportunity:commercial_opportunities!inner(bid_value_low_cents, bid_value_high_cents)
    `)
    .not("competitor_id", "is", null);

  type Row = {
    competitor_id: string;
    outcome: "won" | "lost" | "no_bid";
    debriefed_at: string;
    deciding_factor: string | null;
    opportunity:
      | { bid_value_low_cents: number | null; bid_value_high_cents: number | null }
      | Array<{ bid_value_low_cents: number | null; bid_value_high_cents: number | null }>
      | null;
  };

  // Track deciding_factor counts separately so we can pick the mode
  // per competitor after aggregation.
  const factorCounts = new Map<string, Map<string, number>>();

  const byId = new Map<string, CompetitorLifetimeStats>();
  for (const r of ((data as Row[] | null) ?? [])) {
    const cur = byId.get(r.competitor_id) ?? {
      won_count: 0,
      lost_count: 0,
      no_bid_count: 0,
      total_count: 0,
      last_seen_at: null,
      win_rate_pct: null,
      dollar_lost_cents: 0,
      top_deciding_factor: null,
    };
    if (r.outcome === "won") cur.won_count++;
    else if (r.outcome === "lost") {
      cur.lost_count++;
      // Sum midpoint bid $ for the running "dollar impact" total. Only
      // include when both low + high are known; a lone value is too
      // speculative to count. Zero-bid rows are skipped implicitly.
      const opp = Array.isArray(r.opportunity) ? r.opportunity[0] ?? null : r.opportunity;
      if (opp && opp.bid_value_low_cents !== null && opp.bid_value_high_cents !== null) {
        cur.dollar_lost_cents += Math.round((opp.bid_value_low_cents + opp.bid_value_high_cents) / 2);
      }
      // Tally deciding_factor for lost debriefs only — we care about
      // "why we lose", not "why we win" on this surface.
      if (r.deciding_factor) {
        const inner = factorCounts.get(r.competitor_id) ?? new Map<string, number>();
        inner.set(r.deciding_factor, (inner.get(r.deciding_factor) ?? 0) + 1);
        factorCounts.set(r.competitor_id, inner);
      }
    } else if (r.outcome === "no_bid") cur.no_bid_count++;
    cur.total_count++;
    if (!cur.last_seen_at || r.debriefed_at > cur.last_seen_at) cur.last_seen_at = r.debriefed_at;
    byId.set(r.competitor_id, cur);
  }
  // Compute win rate = won / (won + lost). No-bid excluded because it's not
  // a head-to-head. If no head-to-heads exist we leave win_rate_pct null.
  for (const [id, stats] of byId.entries()) {
    const decided = stats.won_count + stats.lost_count;
    stats.win_rate_pct = decided > 0 ? Math.round((stats.won_count / decided) * 100) : null;
    // Pick the mode deciding_factor for this competitor.
    const inner = factorCounts.get(id);
    if (inner && inner.size > 0) {
      let bestFactor = "";
      let bestCount = 0;
      for (const [factor, count] of inner.entries()) {
        if (count > bestCount) {
          bestFactor = factor;
          bestCount = count;
        }
      }
      stats.top_deciding_factor = bestFactor || null;
    }
  }
  return byId;
}
