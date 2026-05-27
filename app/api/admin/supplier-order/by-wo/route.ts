import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Past orders history per WO. Used by the materials page's right detail
 * pane to show "what's already been ordered for this customer".
 *
 *   GET /api/admin/supplier-order/by-wo?workOrderId=<id>
 *
 * Returns all rows (any status) sorted newest first so admin can see the
 * full audit trail — including failed sends and cancelled drafts. Admin
 * can re-open a draft to send it, or jump from a sent order to its inbox
 * thread via `linked_order_id` on inbox_messages.
 */
export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const workOrderId = url.searchParams.get("workOrderId");
  if (!workOrderId) {
    return NextResponse.json({ error: "missing_work_order_id" }, { status: 400 });
  }

  const sb = createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: rows, error } = await sb
    .from("supplier_orders")
    .select("id, supplier_account_id, supplier_name, po_number, status, fulfillment_method, sent_to_email, sent_at, acknowledged_at, delivered_at, cancelled_at, failure_reason, created_at, updated_at")
    .eq("work_order_id", workOrderId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    orders: rows ?? [],
  });
  } catch (err) {
    console.error("[supplier-order/by-wo GET] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
