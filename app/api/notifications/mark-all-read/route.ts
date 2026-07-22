import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * PATCH /api/notifications/mark-all-read
 *
 * Flips read_at on every unread row for the signed-in user. Scoped by
 * recipient_user_id so a worker only touches their own rows. No body —
 * the action is "all of mine, now."
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Platform scoping: only clear the bell the user is looking at (commercial
  // kinds are `commercial_%`; residential kinds are not). Absent → all.
  const platform = new URL(request.url).searchParams.get("platform");
  let query = adminClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_user_id", user.id)
    .is("read_at", null);
  if (platform === "commercial") query = query.like("kind", "commercial_%");
  else if (platform === "command_center") query = query.not("kind", "like", "commercial_%");

  const { error } = await query;

  if (error) {
    console.warn("[notifications mark-all-read]", error.message);
    return NextResponse.json(
      { error: "update_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
