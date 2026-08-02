/**
 * Work Order — standalone account-scoped route. The tool body lives in
 * `work-order-tool.tsx` (shared with the deal's Project sub-tab, the canonical
 * home); this is a thin wrapper with standalone-page chrome for direct hits /
 * bookmarks / the drawer.
 */
import { WorkOrderTool } from "./work-order-tool";

export default async function WorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string }>;
  searchParams: Promise<{ error?: string; ok?: string; back?: string }>;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <WorkOrderTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
