import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole, homeHrefFor } from "@/lib/auth/roles";
import MeasureSandbox from "@/components/measure-sandbox";

export const dynamic = "force-dynamic";

/**
 * Room measurement — standalone sandbox.
 *
 * Kept off the work order on purpose while it's being evaluated: nothing here
 * writes to `wo_li_sqft_overrides`, so no number produced during testing can
 * reach a supplier order. Connecting it is a small change once the numbers
 * prove out, because the capture libraries it uses are the ones the connected
 * version would use.
 *
 * Gated on canEnterColors — measuring is field work an Account Manager does.
 * Ordering the paint stays admin-only, elsewhere.
 */
export default async function MeasureSandboxPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) redirect("/");
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (!capabilitiesFor(role).canEnterColors) redirect(homeHrefFor(role));

  return (
    <div className="animate-fade-up max-w-3xl mx-auto">
      <MeasureSandbox />
    </div>
  );
}
