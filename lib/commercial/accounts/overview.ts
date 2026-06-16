import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { MS_PER_DAY, ACTIVITY_FRESH_DAYS, ACTIVITY_STALE_DAYS } from "./constants";

/**
 * Account 360 overview — aggregated counts per Account, read straight
 * from the Postgres view `commercial_account_overview_v` (migration 024).
 *
 * Designed to grow: as Phase 2 (Opportunity) and Phase 8 (Billing) ship,
 * we extend the view to include opportunities_count / total_bid /
 * total_invoiced / total_paid / balance_owed. The type widens; UI
 * renders columns it knows about, treats missing ones as "Coming with
 * Phase N" placeholders.
 *
 * No caching here — the view is sub-millisecond on PPP's expected
 * commercial scale (50-500 accounts). Wrap in a memoizer only if the
 * profile data ever shows real cost.
 */

export type AccountOverview = {
  account_id: string;
  contact_count: number;
  ppp_team_count: number;
  active_document_count: number;
  expired_document_count: number;
  expiring_soon_document_count: number;
  document_count_total: number;
  last_activity_at: string; // ISO timestamp
  // ── Phase 2 Batch 5: opportunity rollups (migration 033). NULL when
  //    no opps exist for the account. Tiles render "0" or "—" by
  //    checking for null vs 0 explicitly.
  open_opps_count?: number | null;
  total_active_bid_low_cents?: number | null;
  total_active_bid_high_cents?: number | null;
  won_opps_count?: number | null;
  lost_opps_count?: number | null;
  last_opp_activity_at?: string | null;
  avg_days_to_close?: number | null;
  // ── Future-phase columns (Phase 8 Billing). Typed optional so the
  //    same shape works before and after each phase lands.
  total_invoiced?: number | null;
  total_paid?: number | null;
  balance_owed?: number | null;
  last_invoice_at?: string | null;
};

/** Read the overview for one account. Returns null when the row doesn't
 *  exist (account soft-deleted or never created). */
export async function getAccountOverview(accountId: string): Promise<AccountOverview | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_overview_v")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/overview] get failed:", error.message);
    return null;
  }
  return (data as AccountOverview | null) ?? null;
}

/** Bulk read overviews for the list page. Returns a Map keyed by account_id
 *  so the caller can do O(1) lookups while rendering rows. Missing accounts
 *  silently skip the map (caller renders default placeholders). */
export async function listAccountOverviews(
  accountIds: string[]
): Promise<Map<string, AccountOverview>> {
  if (accountIds.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_overview_v")
    .select("*")
    .in("account_id", accountIds);
  if (error) {
    console.warn("[commercial/overview] list failed:", error.message);
    return new Map();
  }
  const out = new Map<string, AccountOverview>();
  for (const row of (data ?? []) as AccountOverview[]) {
    out.set(row.account_id, row);
  }
  return out;
}

/** Days between a past ISO timestamp and now. Returns null when the
 *  input is missing, malformed, or in the future (clock skew guard). */
export function daysSinceIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / MS_PER_DAY);
}

/** Format `last_activity_at` into a friendly relative string. */
export function relativeActivity(iso: string | null | undefined): string {
  const days = daysSinceIso(iso);
  if (days === null) return "—";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Color tone for the activity badge — green if fresh, amber if stale,
 *  rose if cold. Matches the rest of the platform's color language. */
export function activityTone(iso: string | null | undefined): "ok" | "stale" | "cold" {
  const days = daysSinceIso(iso);
  if (days === null) return "cold";
  if (days <= ACTIVITY_FRESH_DAYS) return "ok";
  if (days <= ACTIVITY_STALE_DAYS) return "stale";
  return "cold";
}

/**
 * Win rate as a fraction 0-1. NULL when no opps have been decided yet
 * (won + lost both 0) — the UI should render "—" rather than "0%" in
 * that case so we don't shame a customer with zero history.
 */
export function winRate(overview: AccountOverview | null | undefined): number | null {
  if (!overview) return null;
  const won = overview.won_opps_count ?? 0;
  const lost = overview.lost_opps_count ?? 0;
  const total = won + lost;
  if (total === 0) return null;
  return won / total;
}

/** Format cents → dollar shorthand. 50_000_00 → "$50k", 1_250_000_00 → "$1.25M". */
function formatCentsShort(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 2)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars)}`;
}

/**
 * Format a bid range in cents → display string. Mirrors formatBidRange
 * in opportunities/db.ts but takes pre-summed totals for the Account
 * scorecard (rather than per-opp low/high).
 *
 *   ($50k, $75k)  →  "$50k–$75k"
 *   ($50k, $50k)  →  "$50k"
 *   (null, $75k)  →  "≤ $75k"
 *   ($50k, null)  →  "$50k+"
 *   (null, null)  →  "—"
 */
export function formatBidCents(
  low: number | null | undefined,
  high: number | null | undefined
): string {
  if ((low === null || low === undefined) && (high === null || high === undefined)) return "—";
  if (low === null || low === undefined) return `≤ ${formatCentsShort(high!)}`;
  if (high === null || high === undefined) return `${formatCentsShort(low)}+`;
  if (low === high) return formatCentsShort(low);
  return `${formatCentsShort(low)}–${formatCentsShort(high)}`;
}
