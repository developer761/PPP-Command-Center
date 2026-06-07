import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Recent activity feed — unifies every interesting timestamp across the
 * customer-form / supplier-order / inbox pipelines into a single feed
 * sorted by time descending. Powers the home-dashboard "Recent Activity"
 * card so the user sees "what happened in my world today" without having
 * to dig through Mail Hub + Materials + Supplier Orders separately.
 *
 *   GET /api/admin/activity?windowHours=24
 *     → { events: ActivityEvent[], summary }
 *
 * Event sources:
 *   - customer_form_tokens.sent_at      → "Color form sent to {customer}"
 *   - customer_form_tokens.opened_at    → "Customer opened color form"
 *   - customer_form_tokens.submitted_at → "Customer submitted colors"
 *   - supplier_orders.sent_at           → "Order sent to {supplier}"
 *   - supplier_orders.acknowledged_at   → "Supplier acknowledged order"
 *   - supplier_orders.delivered_at      → "Materials delivered"
 *   - inbox_messages.received_at        → "Reply from {sender}"
 *
 * Scope: same viewer-aware filtering as /api/admin/sent — workers see
 * activity only for WOs they own.
 *
 * Admin or worker (with scope-filtered results).
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type ActivityEvent = {
  id: string;
  kind:
    | "form_sent" | "form_opened" | "form_submitted"
    | "order_sent" | "order_acknowledged" | "order_delivered"
    | "reply_received";
  at: string;
  /** Short headline for the feed row — already has the relevant noun. */
  label: string;
  /** Optional context (customer name, supplier name, PO #, etc.) */
  detail: string | null;
  workOrderId: string | null;
  workOrderNumber: string | null;
  /** Visual tone — green for "good" milestones, orange for issues, neutral else */
  tone: "positive" | "neutral" | "warning";
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sp = Object.fromEntries(url.searchParams.entries());
    const viewer = await resolveViewer(sp);
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const windowHours = Math.min(parseInt(url.searchParams.get("windowHours") ?? "24", 10) || 24, 168);
    const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 100);

    // Scope to viewer's WOs (skip if admin)
    let scopedWoIds: string[] | null = null;
    if (viewer.scope !== "all") {
      if (!viewer.effectiveUserId) {
        return NextResponse.json({
          ok: true,
          events: [],
          summary: { count: 0, windowHours, scopeNote: "no_sf_user_mapping" },
        });
      }
      const snapshot = await loadSalesforceSnapshot();
      scopedWoIds = snapshot.workOrders
        .filter((w) => w.ownerId === viewer.effectiveUserId)
        .map((w) => w.id);
      if (scopedWoIds.length === 0) {
        return NextResponse.json({
          ok: true,
          events: [],
          summary: { count: 0, windowHours, scopeNote: "no_owned_wos" },
        });
      }
    }

    const sb = adminClient();

    // Build the three source queries. Each captures its own subset of
    // timestamps — we'll unfold each row into 1-3 events client-side.
    // Pull token rows including `kind` so we can drop kind='preview' rows
    // in the unfold loop below. Two .or() calls collide in PostgREST (only
    // the last one wins as a single filter), so we keep the timestamp .or()
    // here and filter preview tokens in code. Audit 2026-06-07 (Karan caught
    // an admin Preview click stamping "Customer Opened" on the timeline).
    let formQuery = sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, customer_name, customer_email, sent_at, opened_at, submitted_at, kind")
      .or(`sent_at.gte.${cutoff},opened_at.gte.${cutoff},submitted_at.gte.${cutoff}`)
      .limit(limit * 2);
    if (scopedWoIds) formQuery = formQuery.in("work_order_id", scopedWoIds);

    let orderQuery = sb
      .from("supplier_orders")
      .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_at, acknowledged_at, delivered_at, status")
      .or(`sent_at.gte.${cutoff},acknowledged_at.gte.${cutoff},delivered_at.gte.${cutoff}`)
      .limit(limit * 2);
    if (scopedWoIds) orderQuery = orderQuery.in("work_order_id", scopedWoIds);

    let inboxQuery = sb
      .from("inbox_messages")
      .select("id, kind, linked_work_order_id, from_email, from_name, subject, received_at")
      .gte("received_at", cutoff)
      .is("archived_at", null)
      .order("received_at", { ascending: false })
      .limit(limit * 2);
    if (scopedWoIds) inboxQuery = inboxQuery.in("linked_work_order_id", scopedWoIds);

    const [formRes, orderRes, inboxRes] = await Promise.allSettled([formQuery, orderQuery, inboxQuery]);

    const events: ActivityEvent[] = [];

    if (formRes.status === "fulfilled" && !formRes.value.error) {
      for (const r of (formRes.value.data ?? []) as Array<{
        token: string; work_order_id: string; work_order_number: string | null;
        customer_name: string | null; customer_email: string;
        sent_at: string | null; opened_at: string | null; submitted_at: string | null;
        kind?: string | null;
      }>) {
        // Skip admin Preview tokens — they're internal QA tools, not real
        // customer activity. Without this guard, a Preview click would
        // surface as "Customer opened color form" in the activity feed.
        if (r.kind === "preview") continue;
        const recipient = r.customer_name ?? r.customer_email;
        if (r.sent_at && r.sent_at >= cutoff) {
          events.push({
            id: `form_sent:${r.token}`,
            kind: "form_sent",
            at: r.sent_at,
            label: "Color form sent",
            detail: `to ${recipient}`,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "neutral",
          });
        }
        if (r.opened_at && r.opened_at >= cutoff) {
          events.push({
            id: `form_opened:${r.token}`,
            kind: "form_opened",
            at: r.opened_at,
            label: "Customer opened color form",
            detail: recipient,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "neutral",
          });
        }
        if (r.submitted_at && r.submitted_at >= cutoff) {
          events.push({
            id: `form_submitted:${r.token}`,
            kind: "form_submitted",
            at: r.submitted_at,
            label: "Customer submitted colors",
            detail: recipient,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "positive",
          });
        }
      }
    }

    if (orderRes.status === "fulfilled" && !orderRes.value.error) {
      for (const r of (orderRes.value.data ?? []) as Array<{
        id: string; work_order_id: string; work_order_number: string | null;
        supplier_name: string; po_number: string;
        sent_at: string | null; acknowledged_at: string | null; delivered_at: string | null;
        status: string;
      }>) {
        if (r.sent_at && r.sent_at >= cutoff) {
          events.push({
            id: `order_sent:${r.id}`,
            kind: "order_sent",
            at: r.sent_at,
            label: `Order sent to ${r.supplier_name}`,
            detail: r.po_number,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "neutral",
          });
        }
        if (r.acknowledged_at && r.acknowledged_at >= cutoff) {
          events.push({
            id: `order_acked:${r.id}`,
            kind: "order_acknowledged",
            at: r.acknowledged_at,
            label: `${r.supplier_name} acknowledged order`,
            detail: r.po_number,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "positive",
          });
        }
        if (r.delivered_at && r.delivered_at >= cutoff) {
          events.push({
            id: `order_delivered:${r.id}`,
            kind: "order_delivered",
            at: r.delivered_at,
            label: "Materials delivered",
            detail: `${r.supplier_name} · ${r.po_number}`,
            workOrderId: r.work_order_id,
            workOrderNumber: r.work_order_number,
            tone: "positive",
          });
        }
      }
    }

    if (inboxRes.status === "fulfilled" && !inboxRes.value.error) {
      for (const r of (inboxRes.value.data ?? []) as Array<{
        id: string; kind: string; linked_work_order_id: string | null;
        from_email: string; from_name: string | null;
        subject: string | null; received_at: string;
      }>) {
        const sender = r.from_name ?? r.from_email;
        const isCustomer = r.kind === "customer_reply";
        events.push({
          id: `reply:${r.id}`,
          kind: "reply_received",
          at: r.received_at,
          label: isCustomer ? "Customer replied" : "Supplier replied",
          detail: `${sender}${r.subject ? ` — ${r.subject}` : ""}`,
          workOrderId: r.linked_work_order_id,
          workOrderNumber: null, // not denormalized on inbox_messages today
          tone: "neutral",
        });
      }
    }

    // Sort desc by timestamp and trim
    events.sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
    const capped = events.slice(0, limit);

    return NextResponse.json({
      ok: true,
      events: capped,
      summary: {
        count: capped.length,
        totalLoaded: events.length,
        windowHours,
      },
    });
  } catch (err) {
    console.error("[admin/activity GET] unhandled:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
