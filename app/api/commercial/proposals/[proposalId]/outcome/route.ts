import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { markProposalOutcome } from "@/lib/commercial/proposals/db";

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
  if (to !== "won" && to !== "lost") {
    return NextResponse.json(
      { error: "invalid_outcome", detail: "to must be 'won' or 'lost'" },
      { status: 400 }
    );
  }

  const result = await markProposalOutcome({
    proposal_id: proposalId,
    outcome: to,
    actor_user_id: auth.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // Lost needs the client to route the user into the debrief form so
  // the loss_reason gets captured. Won just stays put — the kanban
  // refresh will land the card in the Won column.
  const redirect_url =
    to === "lost" && result.account_id
      ? `/commercial/accounts/${result.account_id}/debrief/${result.opportunity_id}?just_closed=1`
      : null;
  return NextResponse.json({
    ok: true,
    proposal_id: result.proposal.id,
    opportunity_id: result.opportunity_id,
    account_id: result.account_id,
    to,
    redirect_url,
  });
}
