import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAllowedToSignIn } from "@/lib/auth/admin";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import CommercialChrome from "@/components/commercial-chrome";

/**
 * /commercial — New Platform layout.
 *
 * Gated end-to-end:
 *   - No session → /
 *   - Not on domain allow-list → /
 *   - No New Platform access flag → /dashboard (back to Command Center)
 *
 * The chrome itself is its own component so the topbar + sidebar shells
 * stay strictly separate from the residential `/dashboard/*` chrome —
 * required by the platform-separation rule.
 */
export default async function CommercialDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAllowedToSignIn(user.email)) {
    redirect("/");
  }

  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) {
    redirect("/dashboard"); // they don't have access — bounce to the platform they DO have
  }

  const email = user.email!;
  const fullName = profile?.sf_user_name ?? email.split("@")[0];
  const firstName = fullName.split(" ")[0] ?? null;
  const initial = (firstName ?? email[0] ?? "P").charAt(0).toUpperCase();

  return (
    <CommercialChrome
      user={{ email, fullName, firstName, initial }}
      showSwitcher={access.hasBoth}
    >
      {children}
    </CommercialChrome>
  );
}
