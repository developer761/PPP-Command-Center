/**
 * Viewer = "who's looking at this page right now, and what should they see?"
 *
 * - For a sales rep: scope is always their own data (`scope: "my"`, effective
 *   user id = their SF User Id).
 * - For an admin: defaults to "all" view (see everything). Can toggle to "my"
 *   to see their own owned data (if they have a SF User Id), or "View As" a
 *   specific rep to impersonate (audit-logged).
 *
 * This shape is serializable — safe to pass from server components into
 * client components via props or React context.
 */

export type ViewerScope = "all" | "my";

export type Viewer = {
  /** Supabase auth user id. */
  supabaseUserId: string;
  email: string;
  /** Display name (from SF) or first part of email. */
  displayName: string;

  /** SF User Id of the signed-in user (null for admins without a SF rep). */
  sfUserId: string | null;
  /** SF User Name of the signed-in user (null if no rep mapping). */
  sfUserName: string | null;

  isAdmin: boolean;

  /** When admin is impersonating: the rep's SF User Id. Else null. */
  viewAsUserId: string | null;
  /** When admin is impersonating: the rep's display name. */
  viewAsName: string | null;

  /**
   * Effective scope after applying all rules:
   *   - non-admin → always "my"
   *   - admin + no view_as + no ?scope=my → "all"
   *   - admin + view_as → "my" (scoped to the impersonated rep)
   *   - admin + ?scope=my (no view_as) → "my" (their own data)
   */
  scope: ViewerScope;

  /**
   * The SF User Id used for `.ownerId === effectiveUserId` filtering when
   * `scope === "my"`. Null when:
   *   - scope === "all" (no filter applied)
   *   - admin with no SF mapping AND no view_as (nothing to filter by → empty view)
   */
  effectiveUserId: string | null;
};

/** True when the dashboard should filter to a single rep's data. */
export function isMyView(viewer: Viewer): boolean {
  return viewer.scope === "my";
}

/** True when the viewer should see everyone's data. */
export function isAllView(viewer: Viewer): boolean {
  return viewer.scope === "all";
}

/** True when the admin is impersonating a specific rep. */
export function isImpersonating(viewer: Viewer): boolean {
  return viewer.isAdmin && !!viewer.viewAsUserId;
}

/**
 * Apply a "my-scope" filter to a list of rows that have an `ownerId` field.
 * - "all" scope: return all rows
 * - "my" scope with effectiveUserId: return only matching ownerId
 * - "my" scope but no effectiveUserId: return empty (admin without rep mapping)
 */
export function filterByViewer<T extends { ownerId?: string | null }>(
  rows: readonly T[],
  viewer: Viewer
): T[] {
  if (viewer.scope === "all") return [...rows];
  if (!viewer.effectiveUserId) return [];
  return rows.filter((r) => r.ownerId === viewer.effectiveUserId);
}
