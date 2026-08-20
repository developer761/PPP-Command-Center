/**
 * Role model for the residential Command Center.
 *
 * Three roles, decided with Karan 2026-07-22. This file is the SINGLE source
 * of truth for what each role can do — every gate (nav, buttons, routes)
 * should derive from `capabilitiesFor(role)` rather than re-deriving booleans.
 *
 *   admin            — everything, including Settings + user management.
 *   account_manager  — sees ALL work orders and enters colors (Internal Entry +
 *                      Send Color Form). Operations Tools ONLY: no analytics
 *                      or finance surfaces (R4.1), cannot order materials
 *                      (greyed), cannot open Settings.
 *   rep              — sees only their OWN work orders + their own numbers.
 *
 * `is_admin` (the legacy boolean on profiles) is mirrored to `role='admin'`
 * so existing code keeps working; new code should prefer `role`.
 */

export type UserRole = "admin" | "account_manager" | "rep";

export const USER_ROLE_VALUES: readonly UserRole[] = [
  "admin",
  "account_manager",
  "rep",
] as const;

export const USER_ROLES: { value: UserRole; label: string; blurb: string }[] = [
  {
    value: "admin",
    label: "Admin",
    blurb:
      "Full access — all work orders, materials ordering, all analytics, and Settings including user management.",
  },
  {
    value: "account_manager",
    label: "Account Manager",
    blurb:
      "Operations only — sees every work order and enters colors (Internal Entry + Send Color Form). No analytics, no materials ordering, no Settings.",
  },
  {
    value: "rep",
    label: "Sales Rep",
    blurb:
      "Sees only their own work orders and their own performance numbers. No ordering, no Settings.",
  },
];

/** Coerce any stored/typed value to a valid UserRole. */
export function normalizeRole(
  value: string | null | undefined,
  adminFallback = false
): UserRole {
  if (value === "admin" || value === "account_manager" || value === "rep") {
    return value;
  }
  return adminFallback ? "admin" : "rep";
}

/** Human label for a role, tolerant of raw/unknown input. */
export function roleLabel(value: string | null | undefined): string {
  const r = normalizeRole(value);
  return USER_ROLES.find((x) => x.value === r)?.label ?? "Sales Rep";
}

export type Capabilities = {
  isAdmin: boolean;
  isAccountManager: boolean;
  /** Sees everyone's data by default (admin or account manager). */
  canSeeAllWorkOrders: boolean;
  /** Place supplier/material orders. Admin only — AM sees it greyed (#5). */
  canOrderMaterials: boolean;
  /** Enter customer colors: Internal Entry + Send Color Form. Admin or AM. */
  canEnterColors: boolean;
  /** Open the Settings hub + provision users. Admin only. */
  canManageSettings: boolean;
  /**
   * See the Sales Analytics and Finance & Ops sections (R4.1).
   *
   * NOT the account manager. Kate: "the only tabs an account manager should
   * see are the tabs under Operations Tools." An AM is an operations role —
   * they run colour forms and materials for every job — and the revenue,
   * margin and rep-performance surfaces aren't theirs.
   *
   * A REP keeps them: their whole reason for logging in is their own numbers,
   * and those pages are already scoped to just their work orders.
   */
  canSeeAnalytics: boolean;
};

/** Where a role should land when it opens the app or clicks the logo. An AM
 *  has no analytics, so the default Overview page would be an instant bounce. */
export function homeHrefFor(role: UserRole): string {
  return role === "account_manager" ? "/dashboard/materials" : "/dashboard";
}

/** Derive the capability set from a role. Single source of truth. */
export function capabilitiesFor(role: UserRole): Capabilities {
  const isAdmin = role === "admin";
  const isAccountManager = role === "account_manager";
  return {
    isAdmin,
    isAccountManager,
    canSeeAllWorkOrders: isAdmin || isAccountManager,
    canOrderMaterials: isAdmin,
    canEnterColors: isAdmin || isAccountManager,
    canManageSettings: isAdmin,
    canSeeAnalytics: !isAccountManager,
  };
}
