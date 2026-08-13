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
import { proposalWentOut } from "@/lib/commercial/proposals/revision-policy";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { hydrateProposalContext } from "@/lib/commercial/proposals/hydrate";
import {
  createProposal,
  findReusableDraftProposal,
  getProposal,
  listLineItemsForProposal,
  createLineItem,
  updateProposal,
} from "@/lib/commercial/proposals/db";
import { remapWorkOrderScopeForOpp } from "@/lib/commercial/work-orders/db";
import { UUID_RE } from "@/lib/commercial/uuid";

export const dynamic = "force-dynamic";

export default async function CreateProposalRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; dealId: string }>;
  searchParams: Promise<{ bump?: string; back?: string }>;
}) {
  const { id: accountId, dealId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(accountId) || !UUID_RE.test(dealId)) notFound();
  // Carry the back-target onto the new proposal so its arrow returns where you
  // came from (e.g. the global Proposals list), not the account. Whitelisted so
  // ?back can't be an open redirect (Karan meeting 2026-08 — recurring nav bug).
  const backQs = sp.back === "/commercial/proposals" ? `&back=${encodeURIComponent("/commercial/proposals")}` : "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
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
  // R1b/R1c: carry the pricing decisions forward on a revision bump.
  let bidSetDate: string | null = null;
  let finalPriceOverride: number | null = null;

  if (sp.bump && UUID_RE.test(sp.bump)) {
    const parent = await getProposal(sp.bump);
    // POLICY (Karan 2026-08-13): a revision only exists once the proposal has
    // GONE TO THE GC and they have asked for changes. Until then the original
    // is the working copy and Kim edits it in place.
    //
    // Enforced here, not just on the button that offers it: this route mutates
    // on GET, so a bookmark, a browser-back, or a hand-typed ?bump= would mint
    // an R2 on an untouched draft and split the work across two rows with
    // nobody able to say which one is live. A hidden button is a suggestion; a
    // guard is the rule.
    // The rule itself lives in revision-policy.ts so it can be tested; see
    // there for why each terminal status counts as "went out".
    const parentWentOut = proposalWentOut(parent);
    if (parent && parent.opportunity_id === dealId && !parentWentOut) {
      // Land on the original rather than erroring — it is the thing they
      // actually want to work on, and saying "no" with no way forward is the
      // shape we do not ship.
      redirect(
        `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${parent.id}?kept=1`
      );
    }
    if (parent && parent.opportunity_id === dealId) {
      parentProposalId = parent.id;
      intro = parent.intro_text_override;
      alternateNotes = parent.alternate_notes;
      bidNotes = parent.bid_notes;
      exclusionIds = parent.exclusion_ids;
      customExclusions = parent.custom_exclusions ?? [];
      pdfShowLinePrices = parent.pdf_show_line_prices;
      bidSetDate = parent.bid_set_date;
      finalPriceOverride = parent.final_price_override_cents;
    }
  }

  // IDEMPOTENCY: this route mutates on GET, so browser-back from the editor
  // re-runs it. Before creating, check whether this exact request already
  // produced a proposal (an untouched draft, or the same bump) and just land
  // on that one instead of minting a duplicate. See findReusableDraftProposal
  // for why the match is deliberately narrow.
  const reusable = await findReusableDraftProposal({
    opportunity_id: dealId,
    parent_proposal_id: parentProposalId,
    created_by_user_id: user.id,
    // Pass the name hydration WOULD stamp so the guard can tell an untouched
    // fresh draft (name still == default) from a renamed one. Without this the
    // guard never matched and browser-back kept minting duplicates.
    hydrated_project_name: ctx.header.project_name ?? null,
  });
  if (reusable) {
    redirect(
      `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${reusable.id}?created=1${backQs}`
    );
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
    const idRemap = new Map<string, string>();
    for (const item of parentItems) {
      const copyResult = await createLineItem(
        {
          proposal_id: result.proposal.id,
          product_id: item.product_id,
          // Carry forward ALL customer-visible fields (Karan 2026-07-27 audit):
          // product_name (071), phase (F.6), and is_labor (063) were being
          // dropped on bump — labor rows became inclusions, phase grouping was
          // lost, and product-only rows (blank description) failed to copy.
          product_name: item.product_name,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price_cents: item.unit_price_cents,
          is_alternate: item.is_alternate,
          is_labor: item.is_labor,
          phase: item.phase,
          position: item.position,
          // R1a: carry per-line price visibility forward too (else it resets to
          // shown on every revision).
          show_price: item.show_price,
        },
        user.id
      );
      if (!copyResult.ok) {
        failed.push(item.description);
      } else {
        // Old line id -> new line id, for the work-order remap below.
        idRemap.set(item.id, copyResult.item.id);
      }
    }
    // Re-point any work order's stored scope at the NEW line ids.
    //
    // A bump copies the parent's items as brand-new rows with brand-new ids,
    // so a work order's scope_line_item_ids matched nothing afterwards and
    // buildWorkOrderContent printed an EMPTY sheet — while the tool's
    // "5 of 8 lines" label (computed from the raw array length) still said 5.
    // Re-open a sent WO, re-send it, and the crew got a work order with no
    // scope of work on it.
    if (idRemap.size > 0) {
      await remapWorkOrderScopeForOpp(dealId, idRemap, user.id).catch((err) => {
        console.warn("[proposal/new] work-order scope remap failed:", err);
      });
    }
    // R1b/R1c: carry the final-price override + bid-set date forward. Done AFTER
    // the line copy so recomputeProposalTotal (inside updateProposal) pins
    // total_cents to the override once the line items exist.
    if (bidSetDate != null || finalPriceOverride != null) {
      await updateProposal({
        id: result.proposal.id,
        bid_set_date: bidSetDate,
        final_price_override_cents: finalPriceOverride,
        updated_by_user_id: user.id,
      });
    }
    if (failed.length > 0) {
      // Land on the editor with a warning + preserve query state so
      // Alex sees exactly which items didn't copy.
      const msg = `Copied ${parentItems.length - failed.length} of ${parentItems.length} line items forward. Failed: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}. Add the rest manually or delete this revision and retry.`;
      redirect(
        `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${result.proposal.id}?error=${encodeURIComponent(msg)}${backQs}`
      );
    }
  }

  redirect(
    `/commercial/accounts/${accountId}/deals/${dealId}/proposal/${result.proposal.id}?created=1${backQs}`
  );
}
