/**
 * Submittals — standalone account-scoped route (the submittal LOG).
 *
 * The log body lives in `submittals-tool.tsx` (shared with the deal's Project
 * sub-tab, the canonical home). This page is a thin wrapper rendering the same
 * body with standalone-page chrome. The submittal DETAIL editor stays a pushed
 * route (`[sid]/page.tsx`) reached from the log.
 */
import { SubmittalsTool, type SubmittalsSP } from "./submittals-tool";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<SubmittalsSP>;

export default async function AccountSubmittalsPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id, dealId } = await params;
  const sp = await searchParams;
  return <SubmittalsTool id={id} dealId={dealId} sp={sp} variant="route" />;
}
