import { NextResponse } from "next/server";
import { rawAccessDenied } from "@/lib/commercial/auth";

import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  markProposalOutcome,
  reopenProposal,
  updateProposalStatus,
  getProposal,
} from "@/lib/commercial/proposals/db";
import {
  PROPOSAL_STATUSES,
  PROPOSAL_ALLOWED_TRANSITIONS,
  type ProposalStatus,
} from "@/lib/commercial/proposals/constants";

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
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (rawAccessDenied(prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { to?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const to = body.to as ProposalStatus | undefined;
  if (!to || !(PROPOSAL_STATUSES as readonly string[]).includes(to)) {
    return NextResponse.json(
      {
        error: "invalid_outcome",
        detail: `to must be one of: ${PROPOSAL_STATUSES.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Karan 2026-07-15: read the current status first so we can route
  // the transition through the right helper. Three flows:
  //   won/lost              → markProposalOutcome (cascades parent deal
  //                           to pre_sale_closed/{won|lost})
  //   sent (from won/lost)  → reopenProposal (uncascades parent deal
  //                           from pre_sale_closed → proposal/sent)
  //   any other transition  → updateProposalStatus (no deal cascade,
  //                           just flips the proposal status; powers
  //                           Draft ↔ Pending Approval, Sent → Expired,
  //                           any → Replaced, etc.)
  const currentProposal = await getProposal(proposalId);
  if (!currentProposal) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const currentStatus = currentProposal.status;
  const isReopenFlow =
    to === "sent" && (currentStatus === "won" || currentStatus === "lost");
  const isOutcomeFlow = to === "won" || to === "lost";

  // Reopen path
  if (isReopenFlow) {
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

  // Outcome path (won/lost) — cascades parent deal
  if (isOutcomeFlow) {
    const result = await markProposalOutcome({
      proposal_id: proposalId,
      outcome: to as "won" | "lost",
      actor_user_id: auth.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
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

  // Sending a proposal must go through the editor's Send button — it renders +
  // snapshots the PDF to Files, sets snapshot_document_id, notifies the team,
  // bumps exclusion use_count, and enforces the ≥1-inclusion guard. A kanban
  // drag to Sent would flip the status and skip ALL of that, leaving a "Sent"
  // proposal with no official PDF and nobody notified (Karan 2026-07-27 audit).
  if (to === "sent") {
    return NextResponse.json(
      {
        error: "use_send_button",
        detail: "Open the proposal and use Send so the PDF is generated and the team is notified.",
      },
      { status: 400 }
    );
  }

  // Enforce the status DAG server-side (Karan 2026-07-27 audit) — the editor
  // only uses it to filter buttons, so a hand-crafted POST or a free kanban
  // drag could otherwise persist an illegal transition (e.g. superseded → *).
  const allowed = PROPOSAL_ALLOWED_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(to)) {
    return NextResponse.json(
      { error: "illegal_transition", detail: `Cannot move a proposal from ${currentStatus} to ${to}.` },
      { status: 400 }
    );
  }

  // Plain status flip — no parent-deal cascade. Draft ↔ Pending,
  // Sent → Expired, any → Replaced, etc.
  const flipped = await updateProposalStatus({
    id: proposalId,
    to_status: to,
    acting_user_id: auth.user.id,
  });
  if (!flipped.ok) {
    return NextResponse.json({ error: flipped.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    proposal_id: flipped.proposal.id,
    opportunity_id: currentProposal.opportunity_id,
    account_id: null,
    to,
    redirect_url: null,
  });
}
