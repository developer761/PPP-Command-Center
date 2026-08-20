import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole, homeHrefFor } from "@/lib/auth/roles";

/**
 * Server guard for the analytics + finance surfaces (R4.1).
 *
 * Hiding a nav link is not access control — an account manager can still type
 * /dashboard/financials, and until this existed they'd get the page. Kate asked
 * for the tabs to be hidden; the access has to actually follow, or the next
 * audit finds revenue data on a role that isn't supposed to have it.
 *
 * Redirects rather than 403s: the AM did nothing wrong, they just followed a
 * stale link or a bookmark, and dropping them on their own home page is more
 * useful than an error. `homeHrefFor` keeps that destination in one place, so
 * an AM never lands on the Overview page they can't see.
 */
export async function requireAnalyticsAccess(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  // Deactivated accounts lose access immediately (bootstrap admins exempt).
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) {
    redirect("/");
  }
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (!capabilitiesFor(role).canSeeAnalytics) {
    redirect(homeHrefFor(role));
  }
}
