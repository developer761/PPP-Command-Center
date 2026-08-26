import { NextResponse } from "next/server";
import { resolveProposalExclusions } from "@/lib/commercial/proposals/exclusion-texts";
import { apiAccessDenied } from "@/lib/commercial/auth";

import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  getProposal,
  listLineItemsForProposal,
} from "@/lib/commercial/proposals/db";
import { listExclusions } from "@/lib/commercial/exclusions/db";
import type { DocumentCategory } from "@/lib/commercial/documents/categories";

/**
 * What Brendan means by "the plans" — the drawing set and anything marked up on
 * top of it. Kept narrow on purpose; see the call site.
 *
 * Typed as DocumentCategory[] so it cannot drift from the real enum: a first
 * draft of this list carried "drawings" and "plans", neither of which is a
 * category this app has ever written, so both would have matched nothing
 * forever and the omission would have looked like "no markups uploaded".
 */
const PLAN_CATEGORIES: ReadonlySet<string> = new Set<DocumentCategory>([
  "bid_set",   // the GC's plan set, and the marked-up copies filed against it
  "submittal", // shop drawings / product data — also drawings a reviewer wants
]);

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
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(auth?.user?.id, prof))) {
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
    .select("id, account_id")
    .eq("id", proposal.opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!oppRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // ...and the ACCOUNT above it. `sendProposal` already refuses the "deal live,
  // account archived" case; the PDF route didn't, so the document was still
  // reachable for an archived GC.
  const accountId = (oppRow as { account_id: string | null }).account_id;
  if (accountId) {
    const { data: accRow } = await sb
      .from("commercial_accounts")
      .select("id")
      .eq("id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!accRow) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }

  const lineItems = await listLineItemsForProposal(proposalId);

  // One resolver, shared with the send path and the estimating-report filing —
  // see lib/commercial/proposals/exclusion-texts.
  const resolved = await resolveProposalExclusions(proposal);
  const exclusions = resolved.filter((e) => e.kind === "exclusion").map((e) => e.text);
  const qualifications = resolved.filter((e) => e.kind === "qualification").map((e) => e.text);

  let pdfBuffer: Buffer;
  try {
    const { renderProposalPdf } = await import(
      "@/lib/commercial/proposals/pdf"
    );
    const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
    pdfBuffer = await renderProposalPdf({
      proposal,
      lineItems,
      exclusions,
      qualifications,
      mode,
      showSignatureBlock,
      company: await getOperatingCompany(),
      // Brendan 2026-08-26: "the marked up plans should be attached to the
      // internal report." Only the plan-side categories — a COI or a saved
      // email is not what he is looking for when he opens the review copy, and
      // listing every file on the opportunity would bury the one that matters.
      // Customer copies never see this.
      attachments:
        mode === "internal"
          ? (await (async () => {
              const { listDocumentsForParent } = await import(
                "@/lib/commercial/documents/db"
              );
              const docs = await listDocumentsForParent(
                "opportunity",
                proposal.opportunity_id
              );
              return docs
                .filter((d) => PLAN_CATEGORIES.has(d.category))
                .map((d) => ({
                  file_name: d.file_name,
                  category: d.category,
                  uploaded_at: d.uploaded_at,
                  size_bytes: d.size_bytes,
                  notes: d.notes,
                }));
            })())
          : [],
      tax: await (async () => {
        const { loadProposalTaxLine } = await import(
          "@/lib/commercial/proposals/proposal-tax-load"
        );
        return loadProposalTaxLine({
          opportunityId: proposal.opportunity_id,
          priceCents: proposal.total_cents,
        });
      })(),
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

  // No `R{n}` in the filename (Brendan 2026-08-17) — the revision is labelled
  // inside the document on the PROJECT line instead.
  const gc = (proposal.header_json.gc_company ?? "Proposal").replace(/[^A-Za-z0-9._-]+/g, "_");
  const project = (proposal.header_json.project_name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = [gc, project]
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
