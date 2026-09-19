import "server-only";

import { type CommercialRole } from "./db";
import { readUserRoles } from "./user-roles";

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
  // Shares the cached read with the crew gate — this was a second, identical
  // query against the same table for the same user, so a render that asked
  // both questions paid the round trip twice.
  const rows = await readUserRoles(userId);
  if (rows === null) return emptyRoleCheck();

  const roles = rows as CommercialRole[];
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
