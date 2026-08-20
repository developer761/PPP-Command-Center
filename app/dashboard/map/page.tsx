import { loadDashboardData } from "@/lib/data-source";
import MapView from "@/components/map-view";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MapPage({ searchParams }: { searchParams: SP }) {
  // R4.1 — an account manager has no analytics access. Guarded here, not
  // just hidden in the nav, so a typed URL or an old bookmark can't reach it.
  await requireAnalyticsAccess();
  const sp = await searchParams;
  // Thin snapshot — MapView only consumes snapshot.workOrders (for plotting
  // job locations) + snapshot.isSandbox (the env banner). Verified by
  // grep — no other snapshot fields are read. Same 60-75% cold-cache cut
  // we got on /dashboard/materials and /dashboard/operations. Audit 2026-06-08.
  const bundle = await loadDashboardData(sp, { thin: true });
  return <MapView bundle={bundle} />;
}
