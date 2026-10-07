import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { roleForProfile, roleLabel } from "@/lib/auth/roles";
import PageHeader from "@/components/page-header";
import ChangePasswordForm from "@/components/change-password-form";
import AccountPhoneForm from "@/components/account-phone-form";
import AccountStateForm from "@/components/account-state-form";

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
  // The state box must show the row it will WRITE to. getProfileByUserId
  // substitutes the proxy target's profile when an admin is acting as somebody
  // else, but /api/account/state resolves the real signed-in user from the
  // session — so without ignoreProxy the field would display one person's state
  // and save over another's.
  const ownProfile = await getProfileByUserId(user.id, { ignoreProxy: true });
  const role = roleForProfile(profile, isAdminEmail(user.email));
  const name = profile?.sf_user_name ?? profile?.full_name ?? user.email?.split("@")[0] ?? "";
  const provider = profile?.auth_provider === "password" ? "Email & password" : "Google";

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Account settings"
        subtitle="Your profile, contact number, the state you order in, and your password."
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

          {/* Karan 2026-09-09 — the number a supplier rings about your orders.
              profiles.phone has been read by the order flow since migration 145
              and printed on the vendor email, but nothing ever wrote to it, so
              it was blank for everyone. */}
          <div className="mt-5 pt-5 border-t border-ppp-charcoal-100">
            <AccountPhoneForm initial={(profile?.phone as string | null) ?? null} />
          </div>

          {/* Karan 2026-10-05 — self-serve, so nobody waits on an admin to be
              able to order. The admin editor on Settings → Access & Users stays
              for corrections. */}
          <div className="mt-5 pt-5 border-t border-ppp-charcoal-100">
            <AccountStateForm initial={ownProfile?.state ?? null} />
          </div>
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
