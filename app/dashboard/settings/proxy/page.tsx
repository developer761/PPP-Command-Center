import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { roleForProfile } from "@/lib/auth/roles";
import { listManagedUsers } from "@/lib/auth/user-management";
import PageHeader from "@/components/page-header";
import ProxyPicker from "@/components/proxy-picker";

/**
 * Settings → Proxy login.
 *
 * Katie, 2026-09-29: "all admins under settings we can have a proxy tab and be
 * able to log in as them and see their view — like Salesforce has." The case
 * behind it: Jason reported a problem in the paint tool and took no
 * screenshots, so somebody has to stand where he was standing.
 *
 * Admin-only, and gated on the REAL profile rather than the effective one.
 * That is deliberate and it cuts both ways: an admin standing in a rep's shoes
 * still reaches this page (so they can switch straight to the next person
 * without returning to their own account first, the way Salesforce does),
 * while a rep who somehow acquires the cookie is refused — the check never
 * reads the identity the cookie is claiming.
 */
export const dynamic = "force-dynamic";

export default async function ProxyLoginPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");

  const realProfile = await getProfileByUserId(user.id, { ignoreProxy: true });
  const realRole = roleForProfile(realProfile, isAdminEmail(user.email));
  if (realRole !== "admin") redirect("/dashboard");

  const users = await listManagedUsers();
  const activeProfile = await getProfileByUserId(user.id);
  const proxyingAs =
    activeProfile && activeProfile.user_id !== user.id
      ? activeProfile.full_name || activeProfile.email
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Proxy login"
        subtitle="See the hub exactly as somebody else sees it — their menus, their permissions, their work orders. Every session is logged."
      />
      <ProxyPicker
        users={users
          .filter((u) => u.user_id !== user.id)
          .map((u) => ({
            userId: u.user_id,
            email: u.email,
            name: u.full_name,
            role: u.role,
            isActive: u.is_active,
          }))}
        proxyingAs={proxyingAs}
      />
    </div>
  );
}
