import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * PATCH /api/notifications/:id/read
 *
 * Marks a single notification read. The UPDATE is gated by both id AND
 * recipient_user_id so a worker can't flip another rep's row even if they
 * guess an id — the WHERE filters them out before the row is touched.
 *
 * Idempotent: re-PATCHing an already-read row leaves read_at unchanged
 * (we only flip when null). Returns ok regardless so the bell doesn't
 * have to special-case the "race lost" path.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// UUID v4 shape — also accepts the deterministic v5 ids we use elsewhere.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { error } = await adminClient()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("recipient_user_id", user.id)
    .is("read_at", null);

  if (error) {
    console.warn("[notifications PATCH read]", error.message);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
