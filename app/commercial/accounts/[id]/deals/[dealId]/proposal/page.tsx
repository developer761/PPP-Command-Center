/**
 * Karan 2026-07-15: this per-deal proposal-list page used to render its
 * own R1/R2/R3 list. It was redundant — the account-page Proposals tab
 * shows everything for a customer (grouped by deal, color-coded by
 * lane, bulk-delete + start-proposal all in one place), and the only
 * way into this URL was the editor's "All revisions ←" breadcrumb.
 * Killed the page and 302 to the account Proposals tab so nobody
 * lands on a confusing standalone screen.
 *
 * URL: /commercial/accounts/[id]/deals/[dealId]/proposal → 302
 */

import { redirect } from "next/navigation";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

export default async function ProposalDealListRedirect({
  params,
}: {
  params: Promise<{ id: string; dealId: string }>;
}) {
  const { id: accountId } = await params;
  const target = UUID_RE.test(accountId)
    ? `/commercial/accounts/${accountId}?tab=proposals`
    : "/commercial/proposals";
  redirect(target);
}
