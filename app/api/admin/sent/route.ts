import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Sent-mail log — every outbound email the Command Center has produced.
 * Counterpart to /api/admin/inbox (inbound replies). Two source tables
 * unioned in-memory:
 *
 *   - customer_form_tokens (kind="form_invite") — every Send Color Form
 *     click that resulted in a successful Resend delivery. sent_at +
 *     resend_message_id + customer_email are the lifecycle anchors.
 *
 *   - supplier_orders (kind="supplier_order") — every Send button push
 *     in the Supplier Order Modal that Resend confirmed. Only rows where
 *     status='sent' (no 'failed' rows; those land elsewhere) AND sent_at
 *     IS NOT NULL.
 *
 * Both surfaces share the same normalized SentMessage shape so the UI can
 * render a single feed sorted by sent_at desc, with a kind chip + a
 * scoped recipient + a deep link back to the originating WO.
 *
 * Pagination via ?limit (default 50, max 200). Filters via ?kind=
 * (all | form_invite | supplier_order) and ?workOrderId=.
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

export type SentMessage = {
  id: string;                       // Composite id: "form:<token>" or "order:<uuid>"
  kind: "form_invite" | "supplier_order";
  sentAt: string;                   // ISO timestamp
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  resendMessageId: string | null;
  deliveryStatus: string | null;    // delivered / bounced / soft_bounced / spam / null
  /** For form invites — link to the live form so admin can sanity-check
   *  what the customer is seeing. */
  formUrl?: string | null;
  /** For supplier orders — PO + supplier label. */
  poNumber?: string | null;
  supplierName?: string | null;
  /** Lifecycle flags for the row badge */
  opened?: boolean;       // form was opened
  submitted?: boolean;    // form was submitted
  acknowledged?: boolean; // supplier acked
  delivered?: boolean;    // materials delivered
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sp = Object.fromEntries(url.searchParams.entries());
    const viewer = await resolveViewer(sp);
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const kind = url.searchParams.get("kind") ?? "all";
    // Coerce empty workOrderId to null — guards against scope-filter bypass
    // via `?workOrderId=` (empty string is falsy but truthy enough to confuse
    // some downstream checks).
    const workOrderIdRaw = url.searchParams.get("workOrderId");
    const workOrderId = workOrderIdRaw && workOrderIdRaw.trim() ? workOrderIdRaw.trim() : null;
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

    // SCOPE: workers see only sent mail for WOs they own.
    let scopedWoIds: string[] | null = null;
    if (viewer.scope !== "all") {
      if (!viewer.effectiveUserId) {
        return NextResponse.json({
          ok: true,
          messages: [],
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0 },
        });
      }
      const snapshot = await loadSalesforceSnapshot();
      const owned = snapshot.workOrders
        .filter((w) => w.ownerId === viewer.effectiveUserId)
        .map((w) => w.id);
      if (workOrderId && !owned.includes(workOrderId)) {
        return NextResponse.json({
          ok: true,
          messages: [],
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0 },
        });
      }
      if (owned.length === 0) {
        return NextResponse.json({
          ok: true,
          messages: [],
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0 },
        });
      }
      scopedWoIds = owned;
    }

    const sb = adminClient();

    let tokenQuery = sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, delivery_status, opened_at, submitted_at, resend_message_id_invite")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (workOrderId) tokenQuery = tokenQuery.eq("work_order_id", workOrderId);
    if (scopedWoIds) tokenQuery = tokenQuery.in("work_order_id", scopedWoIds);

    let orderQuery = sb
      .from("supplier_orders")
      .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_to_email, sent_at, resend_message_id, status, acknowledged_at, delivered_at, delivery_status")
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (workOrderId) orderQuery = orderQuery.eq("work_order_id", workOrderId);
    if (scopedWoIds) orderQuery = orderQuery.in("work_order_id", scopedWoIds);

    // Run both fetches in parallel. If either fails we surface the error but
    // try to return the other half so the UI isn't blank.
    const [tokensRes, ordersRes] = await Promise.all([
      kind === "supplier_order" ? Promise.resolve({ data: [], error: null }) : tokenQuery,
      kind === "form_invite"    ? Promise.resolve({ data: [], error: null }) : orderQuery,
    ]);

    const messages: SentMessage[] = [];
    const errors: string[] = [];

    // If migration 010 hasn't run yet the wider SELECT errors on the
    // missing column — retry with a narrower one so the UI still works.
    let tokenRows: unknown[] = [];
    if (tokensRes.error) {
      const retry = await sb
        .from("customer_form_tokens")
        .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, delivery_status, opened_at, submitted_at")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(limit);
      if (retry.error) {
        errors.push(`form invites: ${retry.error.message}`);
      } else {
        tokenRows = retry.data ?? [];
      }
    } else if (tokensRes.data) {
      tokenRows = tokensRes.data;
    }
    {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      for (const t of tokenRows as Array<{
        token: string; work_order_id: string; work_order_number: string | null;
        customer_email: string; customer_name: string | null; sent_at: string;
        resend_message_id_invite?: string | null; delivery_status: string | null;
        opened_at: string | null; submitted_at: string | null;
      }>) {
        messages.push({
          id: `form:${t.token}`,
          kind: "form_invite",
          sentAt: t.sent_at,
          recipientEmail: t.customer_email,
          recipientName: t.customer_name,
          subject: `Color form — WO #${t.work_order_number ?? t.work_order_id.slice(-6)}`,
          workOrderId: t.work_order_id,
          workOrderNumber: t.work_order_number,
          resendMessageId: t.resend_message_id_invite ?? null,
          deliveryStatus: t.delivery_status,
          formUrl: baseUrl ? `${baseUrl}/select/${t.token}` : null,
          opened: !!t.opened_at,
          submitted: !!t.submitted_at,
        });
      }
    }

    // Same migration-010 fallback for supplier_orders: retry without
    // delivery_status if the column doesn't exist yet so the route still works
    // on a fresh deploy that hasn't run the migration.
    let orderRows: unknown[] = [];
    if (ordersRes.error) {
      const retry = await sb
        .from("supplier_orders")
        .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_to_email, sent_at, resend_message_id, status, acknowledged_at, delivered_at")
        .eq("status", "sent")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(limit);
      if (retry.error) {
        errors.push(`supplier orders: ${retry.error.message}`);
      } else {
        orderRows = retry.data ?? [];
      }
    } else if (ordersRes.data) {
      orderRows = ordersRes.data;
    }
    {
      for (const o of orderRows as Array<{
        id: string; work_order_id: string; work_order_number: string | null;
        supplier_name: string; po_number: string; sent_to_email: string;
        sent_at: string; resend_message_id: string | null; status: string;
        acknowledged_at: string | null; delivered_at: string | null;
        delivery_status?: string | null;
      }>) {
        messages.push({
          id: `order:${o.id}`,
          kind: "supplier_order",
          sentAt: o.sent_at,
          recipientEmail: o.sent_to_email,
          recipientName: o.supplier_name,
          subject: `${o.po_number} — ${o.supplier_name}`,
          workOrderId: o.work_order_id,
          workOrderNumber: o.work_order_number,
          resendMessageId: o.resend_message_id,
          deliveryStatus: o.delivery_status ?? null,
          poNumber: o.po_number,
          supplierName: o.supplier_name,
          acknowledged: !!o.acknowledged_at,
          delivered: !!o.delivered_at,
        });
      }
    }

    // Merge sort by sentAt desc, cap at limit
    messages.sort((a, b) => (b.sentAt < a.sentAt ? -1 : b.sentAt > a.sentAt ? 1 : 0));
    const capped = messages.slice(0, limit);

    return NextResponse.json({
      ok: true,
      messages: capped,
      summary: {
        returned: capped.length,
        totalLoaded: messages.length,
        formInvites: messages.filter((m) => m.kind === "form_invite").length,
        supplierOrders: messages.filter((m) => m.kind === "supplier_order").length,
      },
      warning: errors.length > 0 ? errors.join("; ") : undefined,
    });
  } catch (err) {
    console.error("[admin/sent GET] unhandled:", err);
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
