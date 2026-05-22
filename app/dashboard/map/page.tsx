import { loadDashboardData } from "@/lib/data-source";
import MapView from "@/components/map-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MapPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <MapView bundle={bundle} />;
}
