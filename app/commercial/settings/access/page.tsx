import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import { listManagedUsers } from "@/lib/auth/user-management";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { normalizeEmail } from "@/lib/auth/admin";
import CommercialAccessManager from "@/components/commercial/commercial-access-manager";

/**
 * Commercial Settings → Access.
 *
 * Admin-only. Provisions Commercial-ONLY email+password logins (Tomco crew,
 * estimators, testers) — the mirror of the residential Settings → Access, but
 * every account created here gets Commercial access and NOT Command Center
 * access. "Added from the Commercial side → Commercial only." Someone who needs
 * BOTH platforms (Karan / Katie / Alex) is granted manually.
 *
 * Commercial has a single access level (no sub-roles) — if you have Commercial
 * access you see everything. So there's no role picker here, unlike the PPP side.
 */

export const dynamic = "force-dynamic";

export default async function CommercialAccessPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const profile = await getProfileByUserId(user.id);
  // Provisioning is admin-only (true platform admins), even though Commercial
  // itself is single-level. A Commercial tester is NOT an admin and never lands
  // here — the layout already let them into /commercial; this is the extra gate.
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin") redirect("/commercial/settings/operating-company");

  // Only accounts that actually have Commercial access. Both-platform admins
  // (managed on the PPP Access page) are shown too so the list is honest about
  // who can reach Commercial.
  const users = (await listManagedUsers()).filter((u) => u.has_new_platform_access);
  // R1d: who can approve proposals (besides admins, who always can). Stored on
  // the operating-company singleton; toggled per-user below.
  const oc = await getOperatingCompany();
  const approverEmails = (oc.approver_emails ?? []).map((e) => normalizeEmail(e));

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 animate-fade-up">
      <Link
        href="/commercial/settings"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-ppp-charcoal-500 hover:text-cc-brand-700 mb-2 min-h-[44px] sm:min-h-[36px]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5 M12 19l-7-7 7-7" />
        </svg>
        Settings
      </Link>
      <header className="mb-5">
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <h1 className="text-2xl font-bold tracking-tight text-ppp-charcoal">Access</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1 max-w-2xl">
          Give someone a Commercial login — email + password, no Google needed.
          Accounts made here can reach the Commercial Command Center only, not PPP
          Command Center. Anyone who needs both is set up separately. Flag anyone as
          a <strong>proposal approver</strong> to let them sign off proposals before they go to a GC.
        </p>
      </header>
      <CommercialAccessManager
        initialUsers={users}
        currentUserId={user.id}
        initialApproverEmails={approverEmails}
      />
    </div>
  );
}
