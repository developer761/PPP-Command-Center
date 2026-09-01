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
 *   regional_manager — a rep who oversees a region: everything a rep has, plus
 *                      EVERY work order rather than only their own (Kate,
 *                      2026-09-01). Not an operations role — no ordering, no
 *                      colour entry, no Settings.
 *   rep              — sees only their OWN work orders + their own numbers.
 *
 * `is_admin` (the legacy boolean on profiles) is mirrored to `role='admin'`
 * so existing code keeps working; new code should prefer `role`.
 */

export type UserRole = "admin" | "account_manager" | "regional_manager" | "rep";

export const USER_ROLE_VALUES: readonly UserRole[] = [
  "admin",
  "account_manager",
  "regional_manager",
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
    value: "regional_manager",
    label: "Regional Manager",
    blurb:
      "Everything a Sales Rep has, plus every work order instead of only their own. No materials ordering, no Settings.",
  },
  {
    value: "rep",
    label: "Sales Rep",
    blurb:
      "Sees only their own work orders and their own numbers. Can enter colors and send the color form. No materials ordering, no Settings.",
  },
];

/** Coerce any stored/typed value to a valid UserRole. */
export function normalizeRole(
  value: string | null | undefined,
  adminFallback = false
): UserRole {
  if (
    value === "admin" ||
    value === "account_manager" ||
    value === "regional_manager" ||
    value === "rep"
  ) {
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
  /** Sees everyone's data by default — admin, account manager, or regional
   *  manager. Read this rather than re-deriving it: the rule was duplicated in
   *  two other files, and adding a role to this one alone would have left a
   *  regional manager scoped to their own jobs, which is the opposite of the
   *  point of the role. */
  canSeeAllWorkOrders: boolean;
  /** Place supplier/material orders. Admin only — AM sees it greyed (#5). */
  canOrderMaterials: boolean;
  /**
   * Enter customer colors: Internal Entry + Send Color Form.
   *
   * EVERY role, since Kate 2026-09-01: "the field users should be able to enter
   * colors + send the color form." Colour capture is field work — the rep is
   * standing in the customer's hallway — and gating it to office roles meant
   * the person actually with the customer had to ask someone else to send the
   * form.
   *
   * Kept as a capability rather than deleted: it still gates seven server
   * routes, and a future read-only role must be able to be excluded without
   * re-finding all seven.
   */
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
  const isRegionalManager = role === "regional_manager";
  return {
    isAdmin,
    isAccountManager,
    // A regional manager is a rep in every other respect — the ONE thing that
    // differs is the breadth of what they can see.
    canSeeAllWorkOrders: isAdmin || isAccountManager || isRegionalManager,
    canOrderMaterials: isAdmin,
    // Every role. See the field on Capabilities for why.
    canEnterColors: true,
    canManageSettings: isAdmin,
    canSeeAnalytics: !isAccountManager,
  };
}
