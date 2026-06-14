import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Near-duplicate detection for the create-account flow.
 *
 * When a user types "ABC Properties Management LLC" and we already have
 * "ABC Property Management LLC" on file (different rep, slight spelling
 * variation), we want to surface a warning BEFORE creating a duplicate
 * record. Users can still proceed via a "create anyway" path — this is
 * a heads-up, not a hard block.
 *
 * Strategy:
 *   1. Normalize the input (lowercase, strip common business suffixes
 *      like "LLC", "Inc", trailing punctuation/whitespace).
 *   2. Match against company_name AND dba on existing accounts using
 *      ILIKE on the normalized stem.
 *   3. Cap at 5 results so the UI doesn't render a wall.
 *
 * Returns existing accounts that look similar; empty array if no risk.
 */

export type DuplicateCandidate = {
  id: string;
  company_name: string;
  dba: string | null;
  industry: string | null;
};

/** Strip noise from a company name for matching. */
function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,]/g, " ")
    // Strip common business suffixes (with optional periods + commas)
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co\.?|company|ltd|limited|llp|lp|plc|holdings|group|properties|property)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find existing accounts whose name (or DBA) overlaps with the input.
 *
 * @param companyName — the new name the user typed
 * @param excludeId — optional account id to exclude from results (used
 *   on edit so we don't flag the row being edited as a duplicate of
 *   itself)
 */
export async function findNearDuplicates(
  companyName: string,
  excludeId?: string
): Promise<DuplicateCandidate[]> {
  const stem = normalizeCompanyName(companyName);
  // Need at least 4 chars of signal — any shorter and ilike noise spikes
  // (a "Bob" stem matches every account containing "bob").
  if (stem.length < 4) return [];

  const sb = commercialDb();
  // Escape ILIKE wildcards in the user input.
  const term = `%${stem.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  let q = sb
    .from("commercial_accounts")
    .select("id, company_name, dba, industry")
    .is("deleted_at", null)
    .or(`company_name.ilike.${term},dba.ilike.${term}`)
    .limit(5);
  if (excludeId) q = q.neq("id", excludeId);

  const { data, error } = await q;
  if (error) {
    console.warn("[commercial/duplicates] find failed:", error.message);
    return [];
  }
  return (data ?? []) as DuplicateCandidate[];
}
