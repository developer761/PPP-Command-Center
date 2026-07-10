import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Duplicate opportunity detection (Plan v1.1 Phase B).
 *
 * Brendan's spec + Karan's plan: same account + same client_name + same
 * location_short = probably the same opportunity being logged twice.
 * Warn, don't block — sometimes two bids on the same site are legitimate
 * (different scope, different phase of work, different building on a
 * campus). Server-side check backed by the composite index added in
 * migration 046 (LOWER(client_name), LOWER(location_short) on
 * commercial_opportunities filtered by deleted_at IS NULL).
 *
 * Comparison is case-insensitive + whitespace-trimmed, matching the
 * index expressions so the query uses it. Soft-deleted rows excluded
 * (a deleted "duplicate" isn't really a conflict).
 */

export type DuplicateOpportunityMatch = {
  id: string;
  title: string;
  project_number: string | null;
  status: string;
};

export async function findDuplicateOpportunities(input: {
  accountId: string;
  clientName: string | null;
  locationShort: string | null;
  /** Passed on the edit path so we don't false-alarm against the row
   *  the user is currently editing. */
  excludeOppId?: string | null;
}): Promise<DuplicateOpportunityMatch[]> {
  const client = input.clientName?.trim();
  const location = input.locationShort?.trim();
  // Need both fields to have a signal — one alone is too weak (many opps
  // on the same address, many opps for the same client at different sites).
  if (!input.accountId || !client || !location) return [];

  const sb = commercialDb();
  let query = sb
    .from("commercial_opportunities")
    .select("id, title, project_number, status")
    .eq("account_id", input.accountId)
    .is("deleted_at", null)
    .filter("client_name", "ilike", client)
    .filter("location_short", "ilike", location)
    .limit(5);

  if (input.excludeOppId) {
    query = query.neq("id", input.excludeOppId);
  }

  const { data, error } = await query;
  if (error) {
    console.warn("[commercial/opportunities/duplicates] check failed:", error.message);
    return [];
  }
  return (data ?? []) as DuplicateOpportunityMatch[];
}
