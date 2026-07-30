/**
 * AIA progress billing — standalone account-scoped route.
 *
 * The tool body lives in `aia-tool.tsx` (shared with the deal's Project
 * sub-tab, the canonical home). This page is a thin wrapper rendering the same
 * body with standalone-page chrome for direct hits / bookmarks / the drawer.
 */
import { AiaTool, type AiaSP } from "./aia-tool";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<AiaSP>;

export default async function AiaBillingPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <AiaTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
