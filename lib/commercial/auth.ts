import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";

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
  if (!platformAccess(profile).hasNewPlatform) {
    // Same destination the layout uses for a no-access user.
    redirect("/dashboard");
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
