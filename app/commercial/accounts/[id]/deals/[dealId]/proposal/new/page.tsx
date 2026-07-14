/**
 * Create-a-proposal shim — Phase F.2.
 *
 * Renders as a server component that creates a fresh proposal
 * (hydrated from the account + deal + estimator) then redirects to
 * the editor. If a `?bump=<parentId>` query is present, creates a
 * NEW revision that supersedes that parent, copying its line items +
 * exclusions forward so the user only edits the delta.
 *
 * URL: /commercial/accounts/[id]/deals/[dealId]/proposal/new[?bump=uuid]
 */

import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { hydrateProposalContext } from "@/lib/commercial/proposals/hydrate";
import {
  createProposal,
  getProposal,
  listLineItemsForProposal,
  createLineItem,
} from "@/lib/commercial/proposals/db";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

export default async function CreateProposalRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string }>;
  searchParams: Promise<{ bump?: string }>;
}) {
  const { id: accountId, dealId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(accountId) || !UUID_RE.test(dealId)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const access = platformAccess(profile);
  if (!access.hasNewPlatform) redirect("/commercial");

  const ctx = await hydrateProposalContext(dealId);
  if (!ctx || ctx.opp.account_id !== accountId) notFound();

  // If bumping, copy the parent's overrides forward instead of re-
  // hydrating from account/deal defaults.
  let parentProposalId: string | null = null;
  let intro: string | null = null;
  let alternateNotes: string | null = null;
  let bidNotes: string | null = null;
  let exclusionIds = ctx.standardExclusionIds;
  let customExclusions: string[] = [];
  let pdfShowLinePrices = false;

  if (sp.bump && UUID_RE.test(sp.bump)) {
    const parent = await getProposal(sp.bump);
    if (parent && parent.opportunity_id === dealId) {
      parentProposalId = parent.id;
      intro = parent.intro_text_override;
      alternateNotes = parent.alternate_notes;
      bidNotes = parent.bid_notes;
      exclusionIds = parent.exclusion_ids;
      customExclusions = parent.custom_exclusions ?? [];
      pdfShowLinePrices = parent.pdf_show_line_prices;
    }
  }

  const result = await createProposal({
    opportunity_id: dealId,
    header_json: ctx.header,
    estimator_snapshot_json: ctx.estimator,
    exclusion_ids: exclusionIds,
    custom_exclusions: customExclusions,
    intro_text_override: intro,
    alternate_notes: alternateNotes,
    bid_notes: bidNotes,
    pdf_show_line_prices: pdfShowLinePrices,
    parent_proposal_id: parentProposalId,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal?error=${encodeURIComponent(result.error)}`
    );
  }

  // On bump, copy the parent's line items forward so the estimator
  // only edits the delta. Post-round-2 audit: if a copy fails mid-loop,
  // the new revision would land with partial items and Alex wouldn't
  // know — surface a warning banner with a count so he can decide
  // whether to keep the partial revision or delete + retry.
  if (parentProposalId) {
    const parentItems = await listLineItemsForProposal(parentProposalId);
    const failed: string[] = [];
    for (const item of parentItems) {
      const copyResult = await createLineItem(
        {
          proposal_id: result.proposal.id,
          product_id: item.product_id,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price_cents: item.unit_price_cents,
          is_alternate: item.is_alternate,
          position: item.position,
        },
        user.id
      );
      if (!copyResult.ok) {
        failed.push(item.description);
      }
    }
    if (failed.length > 0) {
      // Land on the editor with a warning + preserve query state so
      // Alex sees exactly which items didn't copy.
      const msg = `Copied ${parentItems.length - failed.length} of ${parentItems.length} line items forward. Failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. Add the rest manually or delete this revision and retry.`;
      redirect(
        `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${result.proposal.id}?error=${encodeURIComponent(msg)}`
      );
    }
  }

  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${result.proposal.id}?created=1`
  );
}
