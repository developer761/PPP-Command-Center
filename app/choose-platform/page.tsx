import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import PlatformPicker from "./platform-picker";
import { homeHrefFor, normalizeRole } from "@/lib/auth/roles";

/**
 * /choose-platform — post-login picker.
 *
 * Routing rules:
 *   - No session → /sign-in
 *   - Has neither access flag → /no-access (falls back to / for now)
 *   - Has only Command Center → redirect to /dashboard
 *   - Has only New Platform → redirect to /commercial
 *   - Has BOTH → render the picker, ALWAYS
 *
 * Note 2026-06-12: prior version auto-routed multi-access users to their
 * last-picked platform via a sticky cookie. That trapped users on their
 * last choice indefinitely. Removed — multi-access users see the picker
 * on every fresh visit. The cookie still exists for future surfaces that
 * want to know "where was the user last," but no auto-routing.
 */
export default async function ChoosePlatformPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);

  if (access.hasNeither) {
    redirect("/");
  }

  if (!access.hasBoth) {
    // R4.1: send an account manager straight to Operations Tools. /dashboard
    // would bounce them there anyway, but this is the first hop of every login
    // and a visible redirect on the way in reads like something went wrong.
    if (access.hasCommandCenter) {
      redirect(homeHrefFor(normalizeRole(profile?.role, profile?.is_admin ?? false)));
    }
    redirect("/commercial");
  }

  return <PlatformPicker email={user.email ?? ""} />;
}
