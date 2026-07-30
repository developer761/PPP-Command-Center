/**
 * Closeout & Warranty — standalone account-scoped route.
 *
 * The tool body lives in `closeout-tool.tsx` (shared with the deal's Project
 * sub-tab, the canonical home). This page is a thin wrapper rendering the same
 * body with standalone-page chrome for direct hits / bookmarks / the drawer.
 */
import { CloseoutTool, type CloseoutSP } from "./closeout-tool";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<CloseoutSP>;

export default async function CloseoutPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <CloseoutTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
