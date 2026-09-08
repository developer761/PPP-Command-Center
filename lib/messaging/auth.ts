import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess, type Profile } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * Messaging-platform authorization for SERVER ACTIONS.
 *
 * The /messaging layout gates page RENDERS on has_messaging_access. A Next.js
 * server action POSTs to a path and executes even when that render-time
 * redirect would have fired, so the layout never protected a single mutation —
 * and every messaging action reaches the database through messagingDb(), which
 * uses the SERVICE ROLE key and bypasses RLS completely. There was nothing
 * else in the way.
 *
 * Action ids are build-global, so the path an action is POSTed to is
 * irrelevant: any signed-in PPP user — a painter with a Dashboard login and no
 * messaging access — could have rewritten Emily's rules for every workspace,
 * changed sending hours, or regraded the training corpus.
 *
 * Commercial found exactly this gap in its 2026-07-27 audit and closed it with
 * assertCommercialAccess. This is the same fix for the same reason, and the
 * fact that it had to be found twice is the argument for the structural test
 * beside it: server-action-auth.test.ts fails if a "use server" file in
 * lib/messaging does not call this.
 */
export function messagingAccessDenied(profile: Profile | null): boolean {
  if (!platformAccess(profile).hasMessaging) return true;
  // A deactivated account loses access everywhere at once. Admins are exempt
  // so they cannot lock themselves out.
  if (profile && profile.is_active === false && !isAdminEmail(profile.email)) return true;
  return false;
}

/**
 * Call this FIRST in every messaging server action, before reading arguments
 * and before touching the database.
 *
 * Returns the caller's user id, so an action that wants to record who did
 * something has it without a second lookup.
 */
export async function assertMessagingAccess(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  if (messagingAccessDenied(profile)) {
    redirect(platformAccess(profile).accessible.length > 0 ? "/choose-platform" : "/");
  }
  return user.id;
}
