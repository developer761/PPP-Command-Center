import RepIndexView from "@/components/rep-index-view";
import { loadDashboardData } from "@/lib/data-source";

export const dynamic = "force-dynamic";

export default async function RepIndexPage() {
  const bundle = await loadDashboardData();
  return <RepIndexView bundle={bundle} />;
}
