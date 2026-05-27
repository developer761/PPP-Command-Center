import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
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
  const url = new URL(request.url);
  const sp = Object.fromEntries(url.searchParams.entries());
  const viewer = await resolveViewer(sp);
  if (!viewer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const kind = url.searchParams.get("kind") ?? "all";
  const archived = url.searchParams.get("archived") === "true";
  // Coerce empty-string workOrderId to null — otherwise `if (workOrderId)`
  // checks below fall through and the scope filter is silently skipped.
  const workOrderIdRaw = url.searchParams.get("workOrderId");
  const workOrderId = workOrderIdRaw && workOrderIdRaw.trim() ? workOrderIdRaw.trim() : null;
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

  // SCOPE: workers see only emails linked to WOs they own. Admin (scope='all')
  // sees everything including the 'unmatched' triage bucket. Workers without
  // an SF user id mapping get an empty result rather than leaking admin data.
  let scopedWoIds: Set<string> | null = null;
  if (viewer.scope !== "all") {
    if (!viewer.effectiveUserId) {
      // Worker has no SF mapping yet — return empty rather than leak data
      return NextResponse.json({
        ok: true,
        messages: [],
        summary: { unread: 0, returned: 0, scopeNote: "no_sf_user_mapping" },
      });
    }
    const snapshot = await loadSalesforceSnapshot();
    scopedWoIds = new Set(
      snapshot.workOrders
        .filter((w) => w.ownerId === viewer.effectiveUserId)
        .map((w) => w.id)
    );
    // If the worker's WO id we got asked for isn't in their owned set,
    // reject — they shouldn't be able to peek via a guessed workOrderId.
    if (workOrderId && !scopedWoIds.has(workOrderId)) {
      return NextResponse.json({
        ok: true,
        messages: [],
        summary: { unread: 0, returned: 0, scopeNote: "wo_not_owned" },
      });
    }
  }

  const sb = adminClient();
  // linked_token is intentionally OMITTED — customer credential not for UI.
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
  // Worker scope: restrict to owned WOs. Use Supabase 'in' filter with the
  // explicit id list (max 1000 — way beyond what one rep owns). Unmatched
  // bucket (no linked_work_order_id) is INVISIBLE to workers since the
  // triage of unidentified mail is admin's job.
  if (scopedWoIds) {
    const owned = Array.from(scopedWoIds);
    if (owned.length === 0) {
      return NextResponse.json({
        ok: true,
        messages: [],
        summary: { unread: 0, returned: 0, scopeNote: "no_owned_wos" },
      });
    }
    query = query.in("linked_work_order_id", owned);
  }

  // Parallelize the messages list fetch + unread count — they're independent
  // queries with no ordering dependency. Saves ~200-400ms on typical inbox
  // sizes (each Supabase query carries network + auth overhead). The unread
  // count is scope-aware so the worker's sidebar badge shows "their unread"
  // not the company-wide unread count.
  let unreadQuery = sb
    .from("inbox_messages")
    .select("id", { count: "exact", head: true })
    .is("read_at", null)
    .is("archived_at", null);
  if (scopedWoIds) {
    unreadQuery = unreadQuery.in("linked_work_order_id", Array.from(scopedWoIds));
  }
  const [messagesRes, unreadRes] = await Promise.all([query, unreadQuery]);
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
  const viewer = await resolveViewer({});
  if (!viewer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  // Scope check — worker can only mark-read/archive messages tied to their
  // owned WOs. Admin (scope='all') skips the check. Without this guard a
  // worker could enumerate inbox_messages.id values and archive other reps'
  // mail. The id space is UUID so guessing is impractical, but defense-in-depth.
  if (viewer.scope !== "all") {
    if (!viewer.effectiveUserId) {
      return NextResponse.json({ error: "forbidden_no_sf_mapping" }, { status: 403 });
    }
    const lookup = await sb
      .from("inbox_messages")
      .select("linked_work_order_id")
      .eq("id", body.messageId)
      .maybeSingle();
    // Return 404 for all "you can't see this" cases — nonexistent message,
    // unmatched (admin-only), or owned-by-another-rep. Distinguishing them
    // with different status codes leaks message-existence information to a
    // worker enumerating UUIDs. From the worker's perspective these are all
    // "the message doesn't exist in your world."
    if (lookup.error || !lookup.data) {
      return NextResponse.json({ error: "message_not_found" }, { status: 404 });
    }
    const linkedWo = lookup.data.linked_work_order_id;
    if (!linkedWo) {
      return NextResponse.json({ error: "message_not_found" }, { status: 404 });
    }
    const snapshot = await loadSalesforceSnapshot();
    const ownsWo = snapshot.workOrders.some(
      (w) => w.id === linkedWo && w.ownerId === viewer.effectiveUserId
    );
    if (!ownsWo) {
      return NextResponse.json({ error: "message_not_found" }, { status: 404 });
    }
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  switch (body.action) {
    case "mark_read":
      patch.read_at = now;
      patch.read_by_user_id = viewer.supabaseUserId;
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
