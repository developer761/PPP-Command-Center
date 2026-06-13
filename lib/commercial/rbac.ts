import "server-only";

import { commercialDb, type CommercialRole } from "./db";

/**
 * Role-based access primitive for the New Platform.
 *
 * Two-tier check:
 *   1. Does the user have ANY New Platform access? (profiles.has_new_platform_access)
 *      — gates entry into /commercial/* (handled by the route layout)
 *   2. Does the user have a specific ROLE? (commercial_user_roles)
 *      — gates specific actions (admin only / pm only / etc.)
 *
 * Phase 0 ships only the role lookup. Project-level access (a PM only sees
 * projects they're on) lands in Phase 5 once `commercial_project_team`
 * exists.
 */

export type RoleCheck = {
  hasAdminRole: boolean;
  hasEstimatorRole: boolean;
  hasPmRole: boolean;
  hasSuperRole: boolean;
  hasForemanRole: boolean;
  hasOfficeRole: boolean;
  hasFieldRole: boolean;
  roles: CommercialRole[];
};

/** Read all roles assigned to a Supabase user inside the New Platform. */
export async function getCommercialRoles(userId: string): Promise<RoleCheck> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) {
    console.warn("[commercial/rbac] getCommercialRoles failed:", error.message);
    return emptyRoleCheck();
  }

  const roles = (data ?? []).map((r) => r.role as CommercialRole);
  return {
    hasAdminRole: roles.includes("admin"),
    hasEstimatorRole: roles.includes("estimator"),
    hasPmRole: roles.includes("pm"),
    hasSuperRole: roles.includes("superintendent"),
    hasForemanRole: roles.includes("foreman"),
    hasOfficeRole: roles.includes("office"),
    hasFieldRole: roles.includes("field"),
    roles,
  };
}

/** Returns a "no roles" RoleCheck — used as a safe fallback. */
export function emptyRoleCheck(): RoleCheck {
  return {
    hasAdminRole: false,
    hasEstimatorRole: false,
    hasPmRole: false,
    hasSuperRole: false,
    hasForemanRole: false,
    hasOfficeRole: false,
    hasFieldRole: false,
    roles: [],
  };
}

/** True when the user can see all commercial records (admin / office). */
export function canSeeAllCommercial(rc: RoleCheck): boolean {
  return rc.hasAdminRole || rc.hasOfficeRole;
}
