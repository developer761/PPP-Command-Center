import { loadDashboardData } from "@/lib/data-source";
import MaterialsView from "@/components/materials-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function MaterialsOrderingPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <MaterialsView bundle={bundle} />;
}
