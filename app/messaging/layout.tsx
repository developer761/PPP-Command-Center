import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/**
 * Messaging — the Hatch replacement, as a peer platform of PPP Command Center
 * and Commercial rather than a page nested inside either. An admin who works in
 * messaging all day should not be two clicks deep, and a conversation carries
 * its own company context in the row rather than in the route.
 *
 * Gated twice on purpose, the same way /admin is: `has_messaging_access` from
 * migration 175 decides who sees the tile, and this layout re-checks
 * server-side on every request. A tile that is merely hidden is not an
 * authorisation boundary — this is.
 *
 * The flag defaults FALSE and is granted deliberately. This surface can send
 * SMS to a customer; nobody should arrive in it by inheriting a role.
 */
export default async function MessagingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);

  // Deactivated accounts lose every platform. Admins are exempt so the
  // platform cannot be bricked — mirrors the dashboard and commercial gates.
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) {
    redirect("/?error=access_revoked");
  }

  const access = platformAccess(profile);
  if (!access.hasMessaging) {
    // Send them somewhere they can actually use rather than a dead end.
    redirect(access.accessible.length > 0 ? "/choose-platform" : "/");
  }

  return <div className="min-h-screen bg-ppp-charcoal-50">{children}</div>;
}
