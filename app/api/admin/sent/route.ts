import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
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
    const kind = url.searchParams.get("kind") ?? "all";
    const workOrderId = url.searchParams.get("workOrderId");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);

    const sb = adminClient();

    // Build the two source queries. Both filter to sent_at NOT NULL so we
    // never surface failed / never-sent rows. workOrderId filter applied to
    // both. Parallel fetch for ~300-500ms savings on cold cache.
    let tokenQuery = sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, resend_message_id, delivery_status, opened_at, submitted_at")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (workOrderId) tokenQuery = tokenQuery.eq("work_order_id", workOrderId);

    let orderQuery = sb
      .from("supplier_orders")
      .select("id, work_order_id, work_order_number, supplier_name, po_number, subject:supplier_name, sent_to_email, sent_at, resend_message_id, status, acknowledged_at, delivered_at")
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (workOrderId) orderQuery = orderQuery.eq("work_order_id", workOrderId);

    // Run both fetches in parallel. If either fails we surface the error but
    // try to return the other half so the UI isn't blank.
    const [tokensRes, ordersRes] = await Promise.all([
      kind === "supplier_order" ? Promise.resolve({ data: [], error: null }) : tokenQuery,
      kind === "form_invite"    ? Promise.resolve({ data: [], error: null }) : orderQuery,
    ]);

    const messages: SentMessage[] = [];
    const errors: string[] = [];

    if (tokensRes.error) {
      errors.push(`form invites: ${tokensRes.error.message}`);
    } else if (tokensRes.data) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      for (const t of tokensRes.data as Array<{
        token: string; work_order_id: string; work_order_number: string | null;
        customer_email: string; customer_name: string | null; sent_at: string;
        resend_message_id: string | null; delivery_status: string | null;
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
          resendMessageId: t.resend_message_id,
          deliveryStatus: t.delivery_status,
          formUrl: baseUrl ? `${baseUrl}/select/${t.token}` : null,
          opened: !!t.opened_at,
          submitted: !!t.submitted_at,
        });
      }
    }

    if (ordersRes.error) {
      errors.push(`supplier orders: ${ordersRes.error.message}`);
    } else if (ordersRes.data) {
      for (const o of ordersRes.data as Array<{
        id: string; work_order_id: string; work_order_number: string | null;
        supplier_name: string; po_number: string; sent_to_email: string;
        sent_at: string; resend_message_id: string | null; status: string;
        acknowledged_at: string | null; delivered_at: string | null;
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
          deliveryStatus: null,
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
