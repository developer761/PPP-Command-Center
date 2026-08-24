import { sfDate } from "@/lib/salesforce/record-field";
import { NextResponse } from "next/server";
import { resolveUserNames } from "@/lib/wo-progress/attribution";
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

/** Kate #07 — resolve staff sender ids → first name. Shares the progress-bar's
 *  resolver (lib/wo-progress/attribution.ts) so the Mail Hub and the work-order
 *  activity history never disagree about what somebody is called. */
const resolveSenderNames = resolveUserNames;

/** Kate #07 — each WO's Salesforce FollowupDate__c (YYYY-MM-DD), for the
 *  follow-up-date activity filter. Best-effort + isolated so a slow/failed SF
 *  call never blocks the sent feed. Tries both org casings. */
async function resolveFollowupDates(
  woIds: string[],
  sb: ReturnType<typeof adminClient>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (woIds.length === 0) return out;

  // Kate round-3 #13: the Command Center's own copy is authoritative here.
  // Reading only Salesforce meant that whenever FollowupDate__c didn't resolve
  // (the data dictionary lists two casings and we probe blindly), every row
  // came back null and the follow-up filter matched nothing on any date — which
  // reads as a broken filter rather than a missing field.
  try {
    const { data, error } = await sb
      .from("wo_followup_dates")
      .select("work_order_id, followup_date")
      .in("work_order_id", woIds);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ work_order_id: string; followup_date: string }>) {
      if (r.followup_date) out.set(r.work_order_id, String(r.followup_date).slice(0, 10));
    }
  } catch (err) {
    // Migration 146 pending — fall through to Salesforce.
    console.warn("[sent] local follow-up dates unavailable:", err);
  }

  // Salesforce fills the gaps: dates set directly in SF, or before the local
  // table existed. Never overwrites a local value.
  const missing = woIds.filter((id) => !out.has(id));
  if (missing.length === 0) return out;
  woIds = missing;
  try {
    const { getSalesforceClient } = await import("@/lib/salesforce/client");
    const conn = await getSalesforceClient();
    const ids = woIds.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id)).map((id) => `'${id}'`);
    if (ids.length === 0) return out;
    // Try the likely casing first; on an invalid-field error fall back to the
    // other — cheaper than a describe() on every Mail Hub load.
    const run = async (field: string) =>
      conn.query<Record<string, unknown>>(`SELECT Id, ${field} FROM WorkOrder WHERE Id IN (${ids.join(",")})`);
    // R4.34 — this is where the filter died, and the reason it died SILENTLY.
    //
    // The real field is `FollowUpDate__c` (capital U). The old code queried
    // "FollowupDate__c" and expected an INVALID_FIELD error to trigger a retry
    // with the other casing. That error never came: SOQL field names are
    // case-INSENSITIVE, so the query succeeded — but jsforce keys the returned
    // record by Salesforce's OWN casing, so `record["FollowupDate__c"]` was
    // undefined on every row. Verified against the live org: querying the wrong
    // casing returns `{ Id, FollowUpDate__c: "2026-08-14" }`.
    //
    // Every follow-up date came back null, so the filter matched nothing on any
    // date — which reads as a broken filter rather than a missing field, and is
    // exactly how Kate reported it twice.
    //
    // Fixed by not guessing: read whichever key actually comes back.
    const res = await run("FollowUpDate__c");
    for (const r of res.records ?? []) {
      const v = sfDate(r, "FollowUpDate__c");
      if (v) out.set(String(r.Id), v);
    }
  } catch (err) {
    console.warn("[sent] follow-up-date resolve failed:", err);
  }
  return out;
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
  expired?: boolean;      // Kate #07 — form invite past expiry, not submitted
  // Kate round-2 #07 — Activity History dimensions.
  senderId?: string | null;      // staffer who sent it (created_by_user_id)
  senderName?: string | null;    // resolved display name
  openedAt?: string | null;      // form opened timestamp
  submittedAt?: string | null;   // colors submitted timestamp
  expiresAt?: string | null;     // form link expiry
  followupDate?: string | null;  // WorkOrder.FollowupDate__c (YYYY-MM-DD)
  /** R5.8: the order was withdrawn AFTER it had already been emailed. */
  cancelledAt?: string | null;
  lastActivityAt?: string | null;// most recent of sent/opened/submitted
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
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0, scopeNote: "no_sf_user_mapping" },
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
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0, scopeNote: "wo_not_owned" },
        });
      }
      if (owned.length === 0) {
        return NextResponse.json({
          ok: true,
          messages: [],
          summary: { returned: 0, totalLoaded: 0, formInvites: 0, supplierOrders: 0, scopeNote: "no_owned_wos" },
        });
      }
      scopedWoIds = owned;
    }

    const sb = adminClient();

    let tokenQuery = sb
      .from("customer_form_tokens")
      .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, delivery_status, opened_at, submitted_at, expires_at, created_by_user_id, resend_message_id_invite, kind")
      .not("sent_at", "is", null)
      // Exclude preview tokens — they shouldn't show as "sent emails" in
      // Mail Hub (admin spun them up to test, no real email went out).
      // Uses Supabase's OR(kind.is.null,kind.neq.preview) so legacy rows
      // without the `kind` column populated still show up.
      .or("kind.is.null,kind.neq.preview")
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (workOrderId) tokenQuery = tokenQuery.eq("work_order_id", workOrderId);
    if (scopedWoIds) tokenQuery = tokenQuery.in("work_order_id", scopedWoIds);

    let orderQuery = sb
      .from("supplier_orders")
      .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_to_email, sent_at, resend_message_id, status, acknowledged_at, delivered_at, delivery_status, created_by_user_id")
      // The Sent tab is the complete record of what actually went out. An order
      // that progressed past "sent" (acknowledged/delivered) is still a sent
      // email — keep it visible so its lifecycle chips render. Excludes "failed"
      // (never sent) and "cancelled" (withdrawn). sent_at NOT NULL is the real
      // "was it sent" guard.
      .in("status", ["sent", "acknowledged", "delivered"])
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
      // The retry MUST carry the same filters as the primary query. It didn't:
      // it dropped the work-order filter, the viewer's ownership scope AND the
      // preview exclusion, so any transient error (not just a missing column)
      // turned a scoped request into a company-wide dump — including live
      // /select/<token> URLs for other reps' customers.
      let retryQ = sb
        .from("customer_form_tokens")
        .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, delivery_status, opened_at, submitted_at, expires_at, created_by_user_id")
        .not("sent_at", "is", null)
        .or("kind.is.null,kind.neq.preview");
      if (workOrderId) retryQ = retryQ.eq("work_order_id", workOrderId);
      else if (scopedWoIds) retryQ = retryQ.in("work_order_id", scopedWoIds);
      const retry = await retryQ
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
        opened_at: string | null; submitted_at: string | null; expires_at?: string | null;
        created_by_user_id?: string | null;
      }>) {
        const lastActivityAt = [t.sent_at, t.opened_at, t.submitted_at]
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? t.sent_at;
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
          // Kate round-2 #07: form invite is "expired" when its link timed out
          // without a submission — powers the Sent view's Expired status filter.
          expired: !t.submitted_at && !!t.expires_at && new Date(t.expires_at).getTime() < Date.now(),
          senderId: t.created_by_user_id ?? null,
          openedAt: t.opened_at,
          submittedAt: t.submitted_at,
          expiresAt: t.expires_at ?? null,
          lastActivityAt,
        });
      }
    }

    // Same migration-010 fallback for supplier_orders: retry without
    // delivery_status if the column doesn't exist yet so the route still works
    // on a fresh deploy that hasn't run the migration.
    let orderRows: unknown[] = [];
    if (ordersRes.error) {
      // Same rule as the token retry above: keep the scope.
      let retryQ = sb
        .from("supplier_orders")
        .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_to_email, sent_at, resend_message_id, status, acknowledged_at, delivered_at, created_by_user_id")
        .eq("status", "sent")
        .not("sent_at", "is", null);
      if (workOrderId) retryQ = retryQ.eq("work_order_id", workOrderId);
      else if (scopedWoIds) retryQ = retryQ.in("work_order_id", scopedWoIds);
      const retry = await retryQ
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
        cancelled_at?: string | null;
        delivery_status?: string | null;
        created_by_user_id?: string | null;
      }>) {
        messages.push({
          id: `order:${o.id}`,
          kind: "supplier_order",
          // Kate round-3 #11: supplier orders never carried a sender, so the
          // Sender filter — which matches on senderName — excluded every one of
          // them. Combining Sender with any supplier status therefore returned
          // zero rows always, and the Sender dropdown didn't even render on a
          // supplier-orders-only view. The column existed (migration 005); it
          // just wasn't selected.
          senderId: o.created_by_user_id ?? null,
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
          cancelledAt: o.cancelled_at ?? null,
          // Cancelling IS activity — it's usually the most recent thing that
          // happened to the order, and the one a reader is looking for.
          lastActivityAt: [o.sent_at, o.acknowledged_at, o.delivered_at, o.cancelled_at]
            .filter((d): d is string => !!d)
            .sort()
            .at(-1) ?? o.sent_at,
        });
      }
    }

    // Merge sort by sentAt desc, cap at limit
    messages.sort((a, b) => (b.sentAt < a.sentAt ? -1 : b.sentAt > a.sentAt ? 1 : 0));
    const capped = messages.slice(0, limit);

    // Kate round-2 #07 (Activity History) — resolve sender display names + attach
    // each WO's Salesforce follow-up date. Both best-effort + parallel so the
    // feed never blocks on them.
    const senderIds = [...new Set(capped.map((m) => m.senderId).filter((x): x is string => !!x))];
    const woIds = [...new Set(capped.map((m) => m.workOrderId).filter((x): x is string => !!x))];
    const [nameById, followupByWo] = await Promise.all([
      resolveSenderNames(sb, senderIds),
      resolveFollowupDates(woIds, sb),
    ]);
    for (const m of capped) {
      if (m.senderId) m.senderName = nameById.get(m.senderId) ?? null;
      if (m.workOrderId) m.followupDate = followupByWo.get(m.workOrderId) ?? null;
    }

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
