import { loadDashboardData } from "@/lib/data-source";
import OperationsView from "@/components/operations-view";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function OperationsPage({ searchParams }: { searchParams: SP }) {
  // R4.1 — an account manager has no analytics access. Guarded here, not
  // just hidden in the nav, so a typed URL or an old bookmark can't reach it.
  await requireAnalyticsAccess();
  const sp = await searchParams;
  // Thin snapshot — deriveOperations only reads snapshot.workOrders (verified
  // by inspecting the function body in lib/salesforce/derive.ts line 1144).
  // Opportunities + quotes + quotas + transactions + reviews + cases +
  // leadStats are never consumed by this page, so we skip them. Cuts
  // cold-cache load from ~8-15s to ~2-4s. Same pattern shipped for
  // /dashboard/materials on 06-06. Audit 2026-06-08.
  const bundle = await loadDashboardData(sp, { thin: true });
  return <OperationsView bundle={bundle} />;
}
