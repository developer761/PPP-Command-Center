import { loadDashboardData } from "@/lib/data-source";
import MapView from "@/components/map-view";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  const bundle = await loadDashboardData();
  return <MapView bundle={bundle} />;
}
