import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { listManagedUsers } from "@/lib/auth/user-management";
import PageHeader from "@/components/page-header";
import AccessManager from "@/components/settings/access-manager";

/**
 * Settings → Access & Users.
 *
 * Admin-only. Provision email+password accounts, assign roles, reset
 * passwords, and activate/deactivate. Supersedes the hardcoded AM allowlist.
 */

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/dashboard");

  const users = await listManagedUsers();

  return (
    <div className="animate-fade-up">
      <div className="mb-2">
        <Link
          href="/dashboard/settings"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ppp-charcoal-400 hover:text-ppp-charcoal-600 transition-colors min-h-[44px]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Settings
        </Link>
      </div>
      <PageHeader
        title="Access & Users"
        subtitle="Give someone a login by pasting their email, setting a password, and choosing a role. They sign in with that email + password — no Google needed."
      />
      <AccessManager initialUsers={users} currentUserId={user.id} />
    </div>
  );
}
