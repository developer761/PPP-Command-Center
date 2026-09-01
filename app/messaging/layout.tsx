import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { sidebarWorkspaces } from "@/lib/messaging/db";
import MessagingChrome from "@/components/messaging/messaging-chrome";

export const dynamic = "force-dynamic";

/**
 * Messaging — a peer platform of PPP Command Center and Commercial.
 *
 * Gated twice, the same way /admin is: has_messaging_access decides who sees
 * the tile, and this layout re-checks server-side on every request. A hidden
 * tile is not an authorisation boundary.
 */
export default async function MessagingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) {
    redirect("/?error=access_revoked");
  }
  const access = platformAccess(profile);
  if (!access.hasMessaging) {
    redirect(access.accessible.length > 0 ? "/choose-platform" : "/");
  }

  const workspaces = await sidebarWorkspaces();
  const initial = (profile?.full_name || user.email || "?").trim()[0]?.toUpperCase() ?? "?";

  return (
    <MessagingChrome workspaces={workspaces} userInitial={initial} accessible={access.accessible}>
      {children}
    </MessagingChrome>
  );
}
