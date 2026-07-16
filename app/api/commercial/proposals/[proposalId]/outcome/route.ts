import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { markProposalOutcome, reopenProposal } from "@/lib/commercial/proposals/db";

/**
 * POST /api/commercial/proposals/[proposalId]/outcome
 * Body: { to: "won" | "lost" }
 *
 * Karan 2026-07-15: powers drag-into-Won-column on the
 * /commercial/proposals kanban. Wraps the SAME `markProposalOutcome`
 * shared helper the proposal-editor button uses so the two paths
 * produce identical side effects (proposal.status flip + parent-deal
 * flip to pre_sale_closed/{won|lost} + audit log via updateProposalStatus).
 *
 * Lost drops return `{ redirect_url }` pointing at the account debrief
 * page so the client can send Alex there to capture the structured
 * reason — Lost without a reason is worthless for the win/loss report.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> }
) {
  const { proposalId } = await params;
  if (!UUID_RE.test(proposalId)) {
    return NextResponse.json({ error: "invalid_proposal_id" }, { status: 400 });
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

  let body: { to?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const to = body.to;
  if (to !== "won" && to !== "lost" && to !== "sent") {
    return NextResponse.json(
      { error: "invalid_outcome", detail: "to must be 'won', 'lost', or 'sent' (reopen)" },
      { status: 400 }
    );
  }

  // "sent" = reopen path — un-marks a Won/Lost proposal + un-flips the
  // parent deal from pre_sale_closed back to Proposal · Sent. Powers
  // the Karan 2026-07-15 undo-marked-Won flow.
  if (to === "sent") {
    const reopened = await reopenProposal({
      proposal_id: proposalId,
      actor_user_id: auth.user.id,
    });
    if (!reopened.ok) {
      return NextResponse.json({ error: reopened.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      proposal_id: reopened.proposal.id,
      opportunity_id: reopened.opportunity_id,
      account_id: reopened.account_id,
      to,
      redirect_url: null,
      reopened: true,
      deal_reopened: reopened.deal_reopened,
      deal_current_status: reopened.deal_current_status,
    });
  }

  const result = await markProposalOutcome({
    proposal_id: proposalId,
    outcome: to,
    actor_user_id: auth.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // Karan 2026-07-15: no more forced redirects on Lost. Prior version
  // yanked the user onto the account debrief page, which was jarring
  // ("wait, why am I not on the proposals kanban anymore?"). The
  // debrief link is now surfaced as a link in the success banner
  // instead — user decides whether to go add the reason now or later.
  const debrief_url =
    to === "lost" && result.account_id
      ? `/commercial/accounts/${result.account_id}/debrief/${result.opportunity_id}?just_closed=1`
      : null;
  return NextResponse.json({
    ok: true,
    proposal_id: result.proposal.id,
    opportunity_id: result.opportunity_id,
    account_id: result.account_id,
    to,
    redirect_url: null,
    debrief_url,
  });
}
