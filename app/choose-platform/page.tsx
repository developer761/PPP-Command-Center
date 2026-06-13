import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { cookies } from "next/headers";
import { PLATFORM_COOKIE, isPlatform } from "@/lib/platform-cookie";
import PlatformPicker from "./platform-picker";

/**
 * /choose-platform — post-login picker.
 *
 * Routing rules:
 *   - No session → /sign-in
 *   - Has neither access flag → /no-access (informational, not built yet — falls back to / for now)
 *   - Has only Command Center → redirect to /dashboard
 *   - Has only New Platform → redirect to /dashboard/commercial
 *   - Has BOTH → render the picker
 *   - Has BOTH and a saved cookie pointing to an accessible platform → redirect there
 *
 * The picker is the ONLY surface that prompts; everything else respects
 * the cookie + flags. So users see the picker at most once per cookie
 * lifetime (90 days) and never if they only have one platform.
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
    // No access page not built yet — bounce to landing with a sign-out trigger
    // would be best, but for now just send to / which will trip the middleware
    // sign-out flow on the next request.
    redirect("/");
  }

  if (!access.hasBoth) {
    if (access.hasCommandCenter) redirect("/dashboard");
    redirect("/dashboard/commercial");
  }

  // Has both — check the cookie for sticky preference.
  const cookieStore = await cookies();
  const lastChoice = cookieStore.get(PLATFORM_COOKIE)?.value;
  if (isPlatform(lastChoice)) {
    if (lastChoice === "command_center") redirect("/dashboard");
    redirect("/dashboard/commercial");
  }

  return <PlatformPicker email={user.email ?? ""} />;
}
