import { loadDashboardData } from "@/lib/data-source";
import OperationsView from "@/components/operations-view";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";
import { deriveOperationsData } from "@/lib/dashboard/operations-data";

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
  // Derive here. Thin cut what the SERVER reads; it did nothing about what
  // the page SENDS — handing `bundle` to a client component serialized the
  // snapshot into the HTML, 35.1MB and 4.7s on a phone off a 200ms TTFB.
  const { snapshot, ...meta } = bundle;
  const data = snapshot ? deriveOperationsData(snapshot) : null;
  return <OperationsView bundle={meta} data={data} />;
}
