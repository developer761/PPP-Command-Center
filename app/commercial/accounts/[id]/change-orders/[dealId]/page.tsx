/**
 * Change Orders — standalone account-scoped route.
 *
 * The tool body now lives in `change-orders-tool.tsx` (shared with the deal's
 * Project sub-tab, which is the canonical home). This page is a thin wrapper
 * that renders the same body with the standalone-page chrome for direct
 * hits / bookmarks / the drawer intercept.
 */
import { ChangeOrdersTool, type ChangeOrdersSP } from "./change-orders-tool";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<ChangeOrdersSP>;

export default async function AccountChangeOrdersPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <ChangeOrdersTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
