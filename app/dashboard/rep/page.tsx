import RepIndexView from "@/components/rep-index-view";
import { loadDashboardData } from "@/lib/data-source";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function RepIndexPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <RepIndexView bundle={bundle} />;
}
