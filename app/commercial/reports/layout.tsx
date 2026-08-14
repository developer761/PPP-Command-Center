import { ReportTabs } from "@/components/commercial/report-tabs";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * Reports framework shell (R4) — the shared report tab bar sits above every
 * /commercial/reports/* page so each report reads as a tab of one Reports area.
 * Kept minimal (just the tabs) so each report page owns its own content/width.
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  // The Estimator report self-gates to admin / account_manager, so resolve the
  // role here and only show that tab to those roles — a sales rep should never
  // see a tab that bounces them (audit D12). Same predicate the page enforces.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const profile = user ? await getProfileByUserId(user.id) : null;
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user?.email));
  const canSeeEstimator = role === "admin" || role === "account_manager";
  return (
    <>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
        <ReportTabs canSeeEstimator={canSeeEstimator} />
      </div>
      {children}
    </>
  );
}
