import DashboardView from "@/components/dashboard-view";
import { loadDashboardData } from "@/lib/data-source";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";

// Force dynamic rendering so SF data refreshes per page load (subject to the
// 5-min server-side snapshot cache inside lib/salesforce/queries.ts).
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);

  // Customer-form pipeline summary for the home-dashboard "Color Forms"
  // card. Depends on the SF snapshot for the WO id list so it sequences
  // AFTER bundle load — but Supabase part is fast (~300ms) once the IDs
  // are in hand. Wrapped in try/catch so a Supabase outage doesn't take
  // down the whole dashboard.
  const openJobs = bundle.snapshot ? deriveOpenMaterialsWorkOrders(bundle.snapshot) : [];
  const woIds = openJobs.map((j) => j.wo.id);
  const formSummary = { sent: 0, opened: 0, submitted: 0, expired: 0, total: 0 };
  if (woIds.length > 0) {
    try {
      const aux = await getMaterialsPageAuxData(woIds);
      for (const status of aux.formStatusByWO.values()) {
        if (status.status === "none") continue;
        formSummary.total += 1;
        if (status.status === "sent") formSummary.sent += 1;
        else if (status.status === "opened") formSummary.opened += 1;
        else if (status.status === "submitted") formSummary.submitted += 1;
        else if (status.status === "expired") formSummary.expired += 1;
      }
    } catch (err) {
      console.warn("[dashboard] form-summary aux load failed (non-fatal):", err);
    }
  }

  return <DashboardView bundle={bundle} formSummary={formSummary} />;
}
