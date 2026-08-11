import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import {
  changeOpportunityStatus,
} from "@/lib/commercial/opportunities/status";
import {
  OPPORTUNITY_STATUSES,
  type OpportunityStatus,
} from "@/lib/commercial/opportunities/db";
import {
  isTerminalOpportunityStatus,
  PRE_SALE_OPEN_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import {
  columnKeyForOpp,
  resolveColumnTarget,
} from "@/lib/commercial/opportunities/kanban-columns";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * POST /api/commercial/opportunities/[id]/move-status
 * Body: { to_status: string }
 *
 * Drag-drop endpoint for the kanban. Same DAG check + audit-log as the
 * server-action quickFlip.
 *
 * Won transitions ALWAYS flip immediately — winning a deal is a
 * celebrated event, shouldn't require paperwork before the status
 * actually moves. The amber "Debrief needed" banner appears on the
 * opp page after the flip; user can fill it later.
 *
 * Lost / No-bid transitions REQUIRE loss_reason (enforced by
 * changeOpportunityStatus) — those still bounce to the detail page so
 * the user can pick the reason inside the structured debrief form.
 *
 * Returns 200 + { ok: true } on success, 4xx + { error } otherwise.
 * Client refreshes the route on success.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = commercialDb();
  const { data: profile } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access || profile?.is_active === false) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: opp_id } = await params;
  if (!opp_id || !UUID_RE.test(opp_id)) {
    return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
  }

  let body: { to_status?: string; to_sub_status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const rawToStatus = String(body.to_status ?? "");
  const explicitSub = body.to_sub_status ? String(body.to_sub_status) : undefined;
  // The kanban posts VISUAL COLUMN KEYS ("rfp", "proposal", "won", …), so
  // resolve through the shared column map rather than a local if-chain —
  // the local chain here knew only "won"/"lost"/"no_bid" and would 400 on
  // any new column. `no_bid` is a retired v1 alias for Lost.
  const columnKey = rawToStatus === "no_bid" ? "lost" : rawToStatus;
  const target = resolveColumnTarget(columnKey);
  const to_status = target?.status ?? rawToStatus;
  const to_sub_status: string | undefined =
    explicitSub ?? target?.sub_status ?? undefined;
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  // A bare `pre_sale_closed` with no sub is ambiguous — and it used to be
  // silently resolved to WON by DEFAULT_SUB_STATUS_BY_STATUS deep inside
  // changeOpportunityStatus. That closed the deal as a win while skipping
  // every won-drop side effect below (placeholder auto-note, debrief
  // redirect), so a deal could go Won with no trace of who decided it.
  // Make the caller say which.
  if (to_status === "pre_sale_closed" && to_sub_status !== "won" && to_sub_status !== "lost") {
    return NextResponse.json(
      { error: "closed_needs_won_or_lost" },
      { status: 400 }
    );
  }
  const isLostDrop = to_status === "pre_sale_closed" && to_sub_status === "lost";
  const isWonDrop = to_status === "pre_sale_closed" && to_sub_status === "won";
  // Snapshot the prior status BEFORE flipping so we can detect the
  // "drag from terminal column back to active" case below and clear the
  // win_loss_debriefed_at flag. Without this, dragging Won → Estimating
  // via kanban left the flag set, so the amber "Debrief needed" banner
  // wouldn't reappear on the next close.
  const { data: priorOpp } = await sb
    .from("commercial_opportunities")
    .select("status, sub_status")
    .eq("id", opp_id)
    .maybeSingle();
  const prior = priorOpp as { status: string; sub_status: string | null } | null;
  const priorStatus = prior?.status ?? null;

  // Dropping a card on the column it's ALREADY in is a no-op, not a
  // rewrite. Each column has one canonical target tuple, so without this
  // a jittery drag inside the Proposal column would rewrite
  // (proposal, follow_up) → (proposal, sent) and silently drop the
  // Follow-Up tag; same for a not-yet-sent proposal sitting in that
  // column as (estimating, proposal_pending_approval), which would get
  // promoted to Sent and then bounce back on the next reconcile. The
  // column is the unit of intent here — the sub-status is set deliberately
  // elsewhere (the deal's status picker), so a drag must not clobber it.
  if (prior && columnKeyForOpp(prior.status, prior.sub_status) === columnKey) {
    return NextResponse.json({ ok: true, redirect_url: null });
  }

  // Lost REQUIRES loss_reason — bounce the user to the detail page where
  // the structured DebriefFields can capture it. Won flips immediately
  // (no reason required).
  if (isLostDrop) {
    return NextResponse.json(
      { error: "terminal_status_needs_detail_page", to_status: "pre_sale_closed", to_sub_status: "lost" },
      { status: 409 }
    );
  }

  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    to_sub_status,
    acting_user_id: auth.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // For Won, drop the placeholder auto-note so the account timeline
  // reflects the closure instantly. Client redirects to the account-
  // scoped debrief page (Karan 2026-07-13: debrief no longer lives
  // under /commercial/opportunities/[id]; it's now under the account).
  let wonRedirectUrl: string | null = null;
  if (isWonDrop) {
    const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
    await postPlaceholderAutoNote({
      opportunityId: opp_id,
      outcome: "won",
      actorUserId: auth.user.id,
    });
    // Look up account_id so the client can jump into the account-
    // scoped debrief page. Falls back to the opp detail as a last
    // resort (should never fire — the opp exists because the flip
    // just succeeded).
    const { data: flipped } = await sb
      .from("commercial_opportunities")
      .select("account_id")
      .eq("id", opp_id)
      .maybeSingle();
    const accountId = (flipped as { account_id: string } | null)?.account_id ?? null;
    wonRedirectUrl = accountId
      ? `/commercial/accounts/${accountId}/debrief/${opp_id}?just_closed=1`
      : `/commercial/opportunities/${opp_id}?tab=debrief&just_closed=1`;
  }
  // If the drag REOPENED a terminal opp back to the active pre-sale
  // pipeline (e.g. dragged Won → Estimating), clear the debriefed_at flag
  // so a future re-close prompts for a fresh debrief. Mirrors the detail-
  // page form path. Idempotent: no-op if flag already null.
  //
  // 2026-07-29 re-audit fix: advancing a WON deal into post-sale delivery
  // (→ pre_construction/in_progress/billing) is terminal→non-terminal but
  // is NOT a reopen — clearing the debrief flag there falsely surfaced the
  // deal under "Awaiting debrief." Gate on the destination being an active
  // pre-sale status, matching the decided_at logic in status.ts.
  const wasTerminal = isTerminalOpportunityStatus(priorStatus);
  const reopensToPipeline = wasTerminal && PRE_SALE_OPEN_STATUSES.includes(to_status);
  if (reopensToPipeline) {
    const { clearDebriefFlagOnReopen } = await import("@/lib/commercial/win-loss/debrief");
    await clearDebriefFlagOnReopen(opp_id, auth.user.id);
  }
  return NextResponse.json({ ok: true, redirect_url: wonRedirectUrl });
}
