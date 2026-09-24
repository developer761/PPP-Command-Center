import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { personName } from "@/lib/commercial/person-name";

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
    const name = personName(user.sf_user_name, user.email, "(unknown)");
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
 * The account's team first, then everybody else on the platform.
 *
 * The account-scoped list above was a deliberate 2026-07-09 narrowing — "if
 * you need someone outside the team, add them to the team first, one
 * authoritative surface". The narrowing is still right about ORDER and wrong
 * about availability: an estimator who belongs to no account team yet cannot
 * be picked anywhere at all. Kim was created as an estimator on 2026-09-23 and
 * would have been invisible in every picker on the platform until somebody
 * thought to add her to an account.
 *
 * `addOpportunityAssignment` has never required account-team membership — it
 * checks active + Commercial access, which is exactly what
 * listPlatformEstimators checks. So the picker was refusing people the
 * assignment layer would have accepted.
 *
 * Grouped, so the team still reads as the obvious answer.
 */
export type EstimatorChoice = EligibleEstimator & { group: string };

export async function listEstimatorChoices(accountId: string): Promise<EstimatorChoice[]> {
  const [team, everyone] = await Promise.all([
    listEligibleEstimators(accountId),
    listPlatformEstimators(),
  ]);
  const onTeam = new Set(team.map((t) => t.user_id));
  return [
    ...team.map((t) => ({ ...t, group: "On this GC's team" })),
    ...everyone.filter((p) => !onTeam.has(p.user_id)).map((p) => ({ ...p, group: "Everyone else" })),
  ];
}

/**
 * Everyone on the platform who could be named as estimator.
 *
 * Two reasons this exists alongside the account-scoped list above.
 *
 * 1. The PIPELINE's New Opportunity form has no account yet — it is chosen in
 *    the same form — so there is no team to scope to. That form shipped with a
 *    plain text box instead, which is what Karan reported on 2026-09-23:
 *    *"when I click like estimator or add team then a dropdown should pop up
 *    with the respective estimator or teams."* A typed name is also nobody:
 *    it writes `estimator_name` and no user id, so the person is not assigned,
 *    not notified, and not on the job's Team tab.
 *
 * 2. A brand-new estimator belongs to no account team yet. Kim was created as
 *    an estimator the same day and would not have appeared in a single picker
 *    on the platform until somebody added her to an account first.
 *
 * Gated on the same two things `addOpportunityAssignment` enforces before it
 * will accept an assignment — active, and has Commercial access — so the
 * picker cannot offer a person the assignment would then refuse. Crew are
 * excluded: they clock in, they do not price work.
 */
export async function listPlatformEstimators(): Promise<EligibleEstimator[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("profiles")
    .select("user_id, email, sf_user_name, full_name, role, is_active, has_new_platform_access")
    .eq("is_active", true)
    .eq("has_new_platform_access", true);

  if (error) {
    console.warn("[commercial/opportunities/estimator] platform list failed:", error.message);
    return [];
  }

  type Row = {
    user_id: string;
    email: string | null;
    sf_user_name: string | null;
    full_name: string | null;
    role: string | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((p) => (p.role ?? "") !== "crew")
    .map((p) => ({
      user_id: p.user_id,
      name: personName(p.sf_user_name ?? p.full_name, p.email ?? "", "(unknown)"),
      role: p.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  return row ? personName(row.sf_user_name, row.email, "") || null : null;
}
