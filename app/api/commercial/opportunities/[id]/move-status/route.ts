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
  QUICK_FLIP_BLOCKED_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * POST /api/commercial/opportunities/[id]/move-status
 * Body: { to_status: string }
 *
 * Drag-drop endpoint for the kanban. Same DAG check + audit-log as the
 * server-action quickFlip. Terminal states (won/lost/no_bid) are
 * rejected here because they need loss_reason capture — the client
 * should bounce the user to the detail page for those.
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
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile?.has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: opp_id } = await params;
  if (!opp_id || !UUID_RE.test(opp_id)) {
    return NextResponse.json({ error: "invalid_opportunity_id" }, { status: 400 });
  }

  let body: { to_status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const to_status = String(body.to_status ?? "");
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (QUICK_FLIP_BLOCKED_STATUSES.has(to_status)) {
    // Won / Lost / No-bid need loss_reason capture. The client should
    // detect this and bounce to /commercial/opportunities/[id]?to=...
    return NextResponse.json(
      { error: "terminal_status_needs_detail_page", to_status },
      { status: 409 }
    );
  }

  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    acting_user_id: auth.user.id,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
