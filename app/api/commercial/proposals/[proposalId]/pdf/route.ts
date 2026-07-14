import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  getProposal,
  listLineItemsForProposal,
} from "@/lib/commercial/proposals/db";
import { listExclusions } from "@/lib/commercial/exclusions/db";

/**
 * GET /api/commercial/proposals/[proposalId]/pdf[?mode=internal]
 *
 * Renders the Tomco-format proposal PDF for a single revision. Two modes:
 *  - default (customer): narrative bullets, single TOTAL, no per-line prices.
 *  - ?mode=internal:     line-item table + prices for Alex/Katie sanity check.
 *
 * Auth pattern mirrors /api/commercial/opportunities/[id]/submittals/[sid]/pdf:
 *  1. supabase.auth.getUser → 401 if missing
 *  2. UUID_RE on proposalId
 *  3. has_new_platform_access check on profiles → 403
 *  4. getProposal already checks deleted_at (chain-of-trust); no separate opp lookup needed
 *  5. Dynamic import keeps @react-pdf/renderer (~3-4 MB) out of every other bundle.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ proposalId: string }> }
) {
  const { proposalId } = await ctx.params;
  if (!UUID_RE.test(proposalId)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!prof || !(prof as { has_new_platform_access: boolean }).has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "internal" ? "internal" : "customer";
  const showSignatureBlock = url.searchParams.get("signature") === "1";

  const proposal = await getProposal(proposalId);
  if (!proposal) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Post-audit fix: getProposal only checks proposal.deleted_at. If the
  // parent opportunity was soft-deleted, this proposal is orphaned —
  // don't render a PDF for something that shouldn't be visible anywhere
  // else in the app.
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("id")
    .eq("id", proposal.opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!oppRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const lineItems = await listLineItemsForProposal(proposalId);

  // Resolve exclusion ids → ordered text list. Preserve the order Alex
  // saved on the proposal (proposal.exclusion_ids drives the sequence).
  // F.5: also merge per-proposal one-off `custom_exclusions` (text lines
  // that don't live in the shared library). Custom lines render AFTER
  // the library-resolved ones, in the order Alex added them.
  let libraryTexts: string[] = [];
  if (proposal.exclusion_ids.length > 0) {
    const all = await listExclusions({ activeOnly: false });
    const byId = new Map(all.map((e) => [e.id, e.text] as const));
    libraryTexts = proposal.exclusion_ids
      .map((id) => byId.get(id))
      .filter((t): t is string => Boolean(t && t.trim()));
    if (libraryTexts.length !== proposal.exclusion_ids.length) {
      console.warn(
        `[proposal-pdf] proposal ${proposalId} references ${proposal.exclusion_ids.length} exclusion ids but only ${libraryTexts.length} resolved — some may be soft-deleted.`
      );
    }
  }
  const customTexts = (proposal.custom_exclusions ?? []).filter(
    (t) => t && t.trim()
  );
  const exclusions = [...libraryTexts, ...customTexts];

  let pdfBuffer: Buffer;
  try {
    const { renderProposalPdf } = await import(
      "@/lib/commercial/proposals/pdf"
    );
    pdfBuffer = await renderProposalPdf({
      proposal,
      lineItems,
      exclusions,
      mode,
      showSignatureBlock,
    });
  } catch (err) {
    // Post-audit fix: log the full error server-side but return an
    // opaque message to the client so react-pdf internals + paths
    // don't leak through the 500 response.
    console.error("[proposal-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed" },
      { status: 500 }
    );
  }

  const rev = `R${proposal.revision_number}`;
  const gc = (proposal.header_json.gc_company ?? "Proposal").replace(/[^A-Za-z0-9._-]+/g, "_");
  const project = (proposal.header_json.project_name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = [gc, project, rev]
    .filter(Boolean)
    .join("_") + (mode === "internal" ? "_internal.pdf" : ".pdf");

  const body = new Uint8Array(pdfBuffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      // Proposals mutate until sent, and even sent proposals may be
      // re-rendered if Alex tweaks a draft revision. Never cache.
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
