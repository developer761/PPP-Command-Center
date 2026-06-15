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
  // ── Future-phase columns (NULL until Phase 2 + Phase 8 ship). Typed
  //    optional so the same shape works both before and after each phase
  //    lands. UI checks for non-null before rendering the KPI tile.
  opportunities_count?: number | null;
  total_bid?: number | null;
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
