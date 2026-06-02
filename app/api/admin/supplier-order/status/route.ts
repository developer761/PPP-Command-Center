import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Admin-driven status transitions for a supplier order. Used by the timeline
 * component's "Mark Acknowledged" / "Mark Delivered" / "Cancel" buttons.
 *
 *   POST /api/admin/supplier-order/status
 *   body: { supplierOrderId: string, status: 'acknowledged'|'delivered'|'cancelled' }
 *
 * Stamps the appropriate timestamp column + flips status. Idempotent — once
 * a stamp is set, re-calling the same transition is a no-op (the timestamp
 * column is `IS NULL`-gated so we capture the FIRST transition only).
 *
 * Admin-only.
 */
export async function POST(request: Request) {
  try {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    supplierOrderId?: string;
    status?: "acknowledged" | "delivered" | "cancelled";
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.supplierOrderId) {
    return NextResponse.json({ error: "missing_supplier_order_id" }, { status: 400 });
  }
  if (!body.status || !["acknowledged", "delivered", "cancelled"].includes(body.status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const sb = createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Build the patch + the IS NULL filter so we only set the timestamp the
  // FIRST time. Subsequent calls become idempotent no-ops.
  const now = new Date().toISOString();
  const tsColumn = body.status === "acknowledged" ? "acknowledged_at"
                 : body.status === "delivered"    ? "delivered_at"
                 : "cancelled_at";

  // Terminal-state guard: a cancelled order can't be promoted back to
  // acknowledged/delivered (otherwise IS NULL guard alone would let admins
  // flip a withdrawn order back to live by clicking the wrong button).
  // Fetch current state once so we can decide whether to allow the move.
  const current = await sb
    .from("supplier_orders")
    .select("id, status, acknowledged_at, delivered_at, cancelled_at")
    .eq("id", body.supplierOrderId)
    .maybeSingle();
  if (current.error) {
    return NextResponse.json({ error: "lookup_failed", message: current.error.message }, { status: 500 });
  }
  if (!current.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (current.data.cancelled_at && body.status !== "cancelled") {
    return NextResponse.json({
      error: "cancelled_order_locked",
      message: "This order was cancelled — it can't be marked acknowledged or delivered. Re-send the order to start a new one.",
      order: current.data,
    }, { status: 409 });
  }

  const { data: row, error } = await sb
    .from("supplier_orders")
    .update({ [tsColumn]: now, status: body.status })
    .eq("id", body.supplierOrderId)
    .is(tsColumn, null)
    .select("id, status, acknowledged_at, delivered_at, cancelled_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  }

  // No row returned → already had the stamp (idempotent path). Return the
  // state we already fetched above so the UI can stay in sync without a
  // second round trip.
  if (!row) {
    return NextResponse.json({ ok: true, idempotentNoOp: true, order: current.data });
  }

  return NextResponse.json({ ok: true, order: row });
  } catch (err) {
    console.error("[supplier-order/status POST] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
