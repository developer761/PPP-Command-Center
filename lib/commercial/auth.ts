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
 * New-Platform flag is missing or the account is deactivated. (No admin-email
 * exemption here — an admin is never `is_active=false` in practice, and these
 * rows don't carry email.)
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
