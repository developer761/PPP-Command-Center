import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Inbox endpoints — list + read/archive actions for /dashboard/inbox.
 *
 *   GET  /api/admin/inbox?kind=all|customer|supplier|unmatched
 *                       &archived=false&workOrderId=<id>
 *     → { messages, summary: { unread, totalInPeriod } }
 *
 *   POST /api/admin/inbox/{id}/read   (PATCH-ish on the message)
 *   POST /api/admin/inbox/{id}/archive
 *     (Both via this same handler with action= body field)
 *
 * Admin-only.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(authData.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(authData.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "all";
  const archived = url.searchParams.get("archived") === "true";
  const workOrderId = url.searchParams.get("workOrderId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

  const sb = adminClient();
  // linked_token is intentionally OMITTED — it's the customer's form
  // credential (anyone with the token can submit colors on their behalf).
  // The UI doesn't need it on the list view; the per-message thread page
  // can resolve linked_work_order_id → token through a scoped helper if
  // we ever surface a "open in customer form" affordance. Until then, no
  // client-side code path needs the token.
  let query = sb
    .from("inbox_messages")
    .select(
      "id, kind, linked_order_id, linked_work_order_id, from_email, from_name, to_email, subject, body_text, resend_message_id, received_at, read_at, archived_at"
    )
    .order("received_at", { ascending: false })
    .limit(limit);

  if (archived) {
    query = query.not("archived_at", "is", null);
  } else {
    query = query.is("archived_at", null);
  }
  if (kind !== "all" && ["customer_reply", "supplier_reply", "unmatched"].includes(kind)) {
    query = query.eq("kind", kind);
  } else if (kind === "customer") {
    query = query.eq("kind", "customer_reply");
  } else if (kind === "supplier") {
    query = query.eq("kind", "supplier_reply");
  } else if (kind === "unmatched") {
    query = query.eq("kind", "unmatched");
  }
  if (workOrderId) {
    query = query.eq("linked_work_order_id", workOrderId);
  }

  // Parallelize the messages list fetch + unread count — they're independent
  // queries with no ordering dependency. Saves ~200-400ms on typical inbox
  // sizes (each Supabase query carries network + auth overhead).
  const [messagesRes, unreadRes] = await Promise.all([
    query,
    sb
      .from("inbox_messages")
      .select("id", { count: "exact", head: true })
      .is("read_at", null)
      .is("archived_at", null),
  ]);
  const { data: messages, error } = messagesRes;
  const unreadCount = unreadRes.count;
  if (error) {
    return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    messages: messages ?? [],
    summary: {
      unread: unreadCount ?? 0,
      returned: messages?.length ?? 0,
    },
  });
}

/**
 * Mark-read + archive — admin clicks on a message thread.
 *
 *   POST /api/admin/inbox
 *   body: { messageId: string, action: 'mark_read' | 'mark_unread' | 'archive' | 'unarchive' }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(authData.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(authData.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { messageId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.messageId) {
    return NextResponse.json({ error: "missing_message_id" }, { status: 400 });
  }
  if (!body.action || !["mark_read", "mark_unread", "archive", "unarchive"].includes(body.action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const sb = adminClient();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  switch (body.action) {
    case "mark_read":
      patch.read_at = now;
      patch.read_by_user_id = authData.user.id;
      break;
    case "mark_unread":
      patch.read_at = null;
      patch.read_by_user_id = null;
      break;
    case "archive":
      patch.archived_at = now;
      break;
    case "unarchive":
      patch.archived_at = null;
      break;
  }

  const { error } = await sb
    .from("inbox_messages")
    .update(patch)
    .eq("id", body.messageId);
  if (error) {
    return NextResponse.json({ error: "update_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
