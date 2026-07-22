import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole, roleLabel } from "@/lib/auth/roles";
import PageHeader from "@/components/page-header";
import ChangePasswordForm from "@/components/change-password-form";

/**
 * Account settings — the signed-in user's own profile + password change.
 * Available to every signed-in user (not admin-gated).
 */

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  const name = profile?.sf_user_name ?? profile?.full_name ?? user.email?.split("@")[0] ?? "";
  const provider = profile?.auth_provider === "password" ? "Email & password" : "Google";

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Account settings"
        subtitle="Your profile and password."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-4">
            Profile
          </h2>
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={name || "—"} />
            <Row label="Email" value={user.email ?? "—"} />
            <Row label="Role" value={roleLabel(role)} />
            <Row label="Sign-in method" value={provider} />
          </dl>
        </section>

        <section className="rounded-xl border border-ppp-charcoal-100 bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ppp-charcoal-400 mb-1">
            Change password
          </h2>
          <p className="text-xs text-ppp-charcoal-400 mb-4">
            Sets the password you use to sign in with email. You can keep using
            Google as well.
          </p>
          <ChangePasswordForm />
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-ppp-charcoal-50 pb-2 last:border-0 last:pb-0">
      <dt className="text-ppp-charcoal-400">{label}</dt>
      <dd className="font-medium text-ppp-charcoal text-right truncate">{value}</dd>
    </div>
  );
}
