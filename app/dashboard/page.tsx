import DashboardView from "@/components/dashboard-view";
import { loadDashboardData } from "@/lib/data-source";
import { deriveOpenMaterialsWorkOrders } from "@/lib/salesforce/materials";
import { getMaterialsPageAuxData } from "@/lib/materials-page-data";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";
import { deriveOverviewData, readPeriod } from "@/lib/dashboard/overview-data";

// Force dynamic rendering so SF data refreshes per page load (subject to the
// 5-min server-side snapshot cache inside lib/salesforce/queries.ts).
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  // R4.1 — an account manager has no analytics access. Guarded here, not
  // just hidden in the nav, so a typed URL or an old bookmark can't reach it.
  await requireAnalyticsAccess();
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

  /**
   * Derive here, on the server, and send the browser the ANSWERS.
   *
   * <DashboardView> is a "use client" component. Passing it `bundle` meant
   * React serialized the entire Salesforce snapshot into the HTML so it
   * could hydrate — 63.8MB and 12.5 seconds on a phone, measured against
   * production 2026-10-16, against a 200ms time to first byte. The server
   * was never the slow part.
   *
   * `period` and `region` come off the URL, which the view already keeps in
   * sync, so a filter change was re-rendering this page regardless. It was
   * just re-sending 64MB each time.
   */
  const { snapshot, ...meta } = bundle;
  const period = readPeriod(sp.period);
  const data = snapshot ? deriveOverviewData(snapshot, period) : null;

  return <DashboardView bundle={meta} data={data} formSummary={formSummary} />;
}
