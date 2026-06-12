import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * GET /api/notifications
 *
 * Returns { unreadCount, items } for the signed-in user. Scoping is
 * recipient-id-only — a row was inserted FOR you or it wasn't. No join
 * against work orders, no admin/worker branching here. That makes leakage
 * impossible: a worker hitting this endpoint reads their own rows or none.
 *
 * Response shape is stable so the bell polls cheaply: a Cache-Control
 * no-store header keeps the count fresh.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = adminClient();

  // Two queries — head:true count for the unread badge (cheap), and the
  // 20 most recent rows for the dropdown. Both filter on the same indexed
  // recipient_user_id so scoping is enforced at the DB.
  const [{ count, error: cntErr }, { data: items, error: itemsErr }] = await Promise.all([
    sb
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_user_id", user.id)
      .is("read_at", null),
    sb
      .from("notifications")
      .select("id, kind, work_order_id, work_order_number, customer_name, title, body, link, read_at, created_at")
      .eq("recipient_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (cntErr || itemsErr) {
    console.warn("[notifications GET]", cntErr?.message ?? itemsErr?.message);
    return NextResponse.json(
      { error: "load_failed", unreadCount: 0, items: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { unreadCount: count ?? 0, items: items ?? [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
