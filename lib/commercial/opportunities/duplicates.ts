import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Duplicate opportunity detection (Plan v1.1 Phase B).
 *
 * Same account + same client_name + same property_street = probably the
 * same opportunity being logged twice. Warn, don't block — sometimes two
 * bids on the same site are legitimate (different scope, different phase
 * of work, different building on a campus).
 *
 * Karan 2026-07-20 (Phase G Q2): keyed on property_street after
 * location_short retired (migration 066 backfill, migration 068 drop).
 * Comparison is case-insensitive + whitespace-trimmed; soft-deleted
 * rows excluded.
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
  propertyStreet: string | null;
  /** Passed on the edit path so we don't false-alarm against the row
   *  the user is currently editing. */
  excludeOppId?: string | null;
}): Promise<DuplicateOpportunityMatch[]> {
  const client = input.clientName?.trim();
  const location = input.propertyStreet?.trim();
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
    .filter("property_street", "ilike", location)
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
