import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Eligible-estimators lookup for the New Opportunity + Edit forms.
 *
 * Sourced from `commercial_account_assignments` (the account's team) so
 * the picker only shows people who already have an active relationship
 * with the client. If Alex needs someone outside the team as estimator,
 * he adds them to the team first — one authoritative surface, not two.
 *
 * Karan 2026-07-09 Phase B: kept simple per the "simpler is better"
 * rule. Native `<select>` on the form, no combobox, no is_active gate
 * (removed_at IS NULL on the assignment IS the active gate). If a team
 * outgrows 15 members we swap to a searchable picker.
 */

export type EligibleEstimator = {
  user_id: string;
  name: string; // full name if available, else email
  role: string | null;
};

export async function listEligibleEstimators(accountId: string): Promise<EligibleEstimator[]> {
  if (!accountId) return [];
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_assignments")
    .select(
      "role, is_primary, user_id, user:profiles!commercial_account_assignments_user_id_fkey(user_id, email, sf_user_name)"
    )
    .eq("account_id", accountId)
    .is("removed_at", null);

  if (error) {
    console.warn("[commercial/opportunities/estimator] list failed:", error.message);
    return [];
  }

  type Row = {
    role: string | null;
    is_primary: boolean;
    user_id: string;
    user:
      | { user_id: string; email: string; sf_user_name: string | null }
      | Array<{ user_id: string; email: string; sf_user_name: string | null }>
      | null;
  };

  // Dedupe by user_id — a team member with multiple roles appears once.
  const byUser = new Map<string, EligibleEstimator>();
  for (const raw of (data ?? []) as unknown as Row[]) {
    const user = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!user) continue;
    const name = user.sf_user_name || user.email || "(unknown)";
    const existing = byUser.get(user.user_id);
    if (existing) {
      // Prefer showing an estimator-flagged role if the user has one,
      // else keep the first role we saw.
      if (raw.role === "estimator") existing.role = "estimator";
    } else {
      byUser.set(user.user_id, {
        user_id: user.user_id,
        name,
        role: raw.role,
      });
    }
  }
  // Sort alphabetically for a stable dropdown order.
  return Array.from(byUser.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up a single estimator's display name — used on the opp detail
 * page and Timeline entries when we want to show "Assigned to Sarah"
 * without re-fetching the whole team. Falls back to email or a
 * placeholder if the profile row is missing (e.g. the user was
 * deleted after being assigned; the FK is SET NULL on delete but
 * historic log rows may still reference the old id).
 */
export async function getEstimatorDisplayName(
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const sb = commercialDb();
  const { data } = await sb
    .from("profiles")
    .select("sf_user_name, email")
    .eq("user_id", userId)
    .maybeSingle();
  const row = data as { sf_user_name: string | null; email: string | null } | null;
  return row?.sf_user_name || row?.email || null;
}
