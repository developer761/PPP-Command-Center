import { loadDashboardData } from "@/lib/data-source";
import MapView from "@/components/map-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MapPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  // Thin snapshot — MapView only consumes snapshot.workOrders (for plotting
  // job locations) + snapshot.isSandbox (the env banner). Verified by
  // grep — no other snapshot fields are read. Same 60-75% cold-cache cut
  // we got on /dashboard/materials and /dashboard/operations. Audit 2026-06-08.
  const bundle = await loadDashboardData(sp, { thin: true });
  return <MapView bundle={bundle} />;
}
