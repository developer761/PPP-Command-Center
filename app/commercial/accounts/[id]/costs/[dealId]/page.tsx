/**
 * Costs & Job P&L — standalone account-scoped route.
 *
 * The tool body lives in `costs-tool.tsx` (shared with the deal's Project
 * sub-tab, the canonical home). This thin wrapper renders it with the
 * standalone-page chrome for direct hits / bookmarks / the drawer intercept —
 * mirrors the sibling tools (change-orders / aia / submittals / closeout).
 */
import { ProjectCostsTool, type CostsSP } from "./costs-tool";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<CostsSP>;

export default async function AccountCostsPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <ProjectCostsTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
