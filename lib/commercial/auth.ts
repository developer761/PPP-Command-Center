import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess, type Profile } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * The single commercial-access policy: does this profile LACK access right now?
 * Denied when it has no New-Platform flag, or when it's deactivated (admins
 * exempt — they can't lock themselves out). Route handlers use this to return a
 * JSON 403; server actions go through {@link assertCommercialAccess} which
 * redirects. Keeping the rule in one predicate means a deactivated tester can't
 * slip through one surface after being cut off on another.
 */
export function commercialAccessDenied(profile: Profile | null): boolean {
  if (!platformAccess(profile).hasNewPlatform) return true;
  if (profile && profile.is_active === false && !isAdminEmail(profile.email)) return true;
  return false;
}

/**
 * Same policy for API routes that fetch a PARTIAL profile row via the
 * service-role client (they only `select("has_new_platform_access, is_active")`,
 * not the full Profile). Narrows the raw row internally so a route reduces its
 * whole auth check to `if (rawAccessDenied(row)) return 403`. Denied when the
 * New-Platform flag is missing or the account is deactivated.
 *
 * INTENTIONAL asymmetry vs commercialAccessDenied: no admin-email exemption
 * here (the partial rows don't carry email). If an admin were ever deactivated
 * they'd be 403'd on these routes while the layout/server-actions still let
 * them in — that's fail-CLOSED (safer) and a non-scenario in practice (admins
 * deactivate others, not themselves). Kept deliberately simple over selecting
 * email in every route just to re-admit a deactivated admin.
 */
export function rawAccessDenied(row: unknown): boolean {
  const p = row as { has_new_platform_access?: boolean | null; is_active?: boolean | null } | null;
  return !p?.has_new_platform_access || p?.is_active === false;
}

/**
 * Commercial-platform authorization for SERVER ACTIONS (Karan 2026-07-27 audit).
 *
 * The /commercial layout gates page RENDERS on `has_new_platform_access`, but a
 * Next.js server action POSTs to the page path and executes even when the
 * render-time redirect would have fired — so the layout does NOT protect
 * mutations. Every commercial API route already re-checks the flag; the server
 * actions did not. These helpers close that gap.
 *
 * Cheap: `getProfileByUserId` is cached ~30s, so the extra read is effectively
 * free within a request cycle.
 */

/**
 * Redirect unless `userId` holds commercial-platform access. Call this inside
 * every commercial server action, right after the `if (!user) redirect(...)`
 * gate, passing the resolved `user.id`.
 */
export async function assertCommercialAccess(userId: string): Promise<void> {
  const profile = await getProfileByUserId(userId);
  // The layout redirects a deactivated / no-access user on page RENDER, but a
  // server action POSTs to the path and runs even when that render-time redirect
  // would have fired — so without this, a revoked tester could still mutate
  // commercial data. Same predicate the API routes use (2026-08 security sweep).
  if (commercialAccessDenied(profile)) {
    redirect(platformAccess(profile).hasNewPlatform ? "/?error=access_revoked" : "/dashboard");
  }
}

/**
 * Full gate for actions that don't already have the user in scope: resolves the
 * session, requires commercial access, and returns the user id. Redirects
 * otherwise (no return).
 */
export async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

/**
 * API-route gate that ALSO denies crew-only logins.
 *
 * The crew allowlist in lib/commercial/crew-access.ts is enforced in the
 * /commercial LAYOUT — which never runs for /api/* routes, and proxy.ts only
 * matches page paths. So a crew login could call the palette search, the
 * job-costs export, the AR-aging export, account-summary, document downloads
 * … and get full company financials by pasting a URL. That is exactly the
 * fail-open the allowlist design was written to prevent; the design was right
 * and the enforcement was incomplete (persona audit 2026-08).
 *
 * This is the choke point every commercial API route already funnels through,
 * so denying here closes the whole class at once rather than route by route.
 *
 * `allowCrew` opts a route back IN — only for endpoints a crew member must be
 * able to call (the PIN clock). Keep that list tiny and obvious.
 */
export async function apiAccessDenied(
  userId: string | null | undefined,
  row: unknown,
  opts?: { allowCrew?: boolean }
): Promise<boolean> {
  if (rawAccessDenied(row)) return true;
  if (opts?.allowCrew) return false;
  if (!userId) return true;
  const { isCrewOnlyUser } = await import("@/lib/commercial/crew-access");
  return await isCrewOnlyUser(userId);
}

/**
 * Deny a crew-only login on an API route. Returns a 403 Response to return, or
 * null to continue.
 *
 * A second entry point alongside apiAccessDenied because roughly two dozen
 * commercial API routes never funnelled through that helper — they hand-rolled
 * `has_new_platform_access && is_active`, which EVERY crew login satisfies by
 * definition (the layout requires it to let them in at all). So the crew
 * allowlist, which only governs page renders, left the whole /api tree open:
 * the accounts export (the entire book of business as CSV), the opportunities
 * export, AIA workbooks with contract sums, every document and attachment
 * download, and mutations like move-status.
 *
 * Two lines at the top of a handler, no restructuring of its existing gate:
 *
 *   const denied = await denyCrewApi(userId);
 *   if (denied) return denied;
 */
export async function denyCrewApi(
  userId: string | null | undefined
): Promise<Response | null> {
  if (!userId) return null; // the route's own auth gate owns the anonymous case
  const { isCrewOnlyUser } = await import("@/lib/commercial/crew-access");
  if (await isCrewOnlyUser(userId)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
