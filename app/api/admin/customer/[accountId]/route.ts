import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Per-customer history bundle for /dashboard/customer/[accountId].
 *
 *   GET /api/admin/customer/<sf-account-id>
 *
 * Returns the customer's identity, lifetime value, full WO list, full
 * Opp list, and a unified mail timeline (every form invite, supplier
 * order, and inbox message tied to ANY of their WOs).
 *
 * SCOPE RULES:
 *   - Admin (scope='all'): full account view, every WO + every email
 *   - Worker (scope='my'): account view filtered to WOs THEY own. Mail
 *     also filtered to WOs they own. The Account record still shows
 *     lifetime totals (which include other reps' work) because those
 *     come from SF aggregate fields — the worker just sees "their slice"
 *     of the WO list + mail. We could hide lifetime numbers from workers
 *     but they're informational, not sensitive (and reps benefit from
 *     knowing a customer is a repeat).
 *
 * Returns 404 (not 403) when the worker has no owned WOs at this
 * account — same enumeration-resistant pattern as the inbox.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type CustomerMailEvent = {
  id: string;
  kind:
    | "form_sent" | "form_opened" | "form_submitted"
    | "order_sent" | "order_acknowledged" | "order_delivered"
    | "reply_in";
  at: string;
  workOrderId: string;
  workOrderNumber: string | null;
  /** Recipient (outbound) or sender (inbound) label */
  who: string;
  /** Short headline */
  label: string;
  /** Extra context line (PO#, finish, body preview, etc.) */
  detail: string | null;
  tone: "positive" | "neutral" | "warning";
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    if (!accountId || !accountId.startsWith("001")) {
      // SF Account ids start with 001 — reject everything else cleanly.
      return NextResponse.json({ error: "invalid_account_id" }, { status: 400 });
    }

    const viewer = await resolveViewer({});
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let snapshot;
    try {
      snapshot = await loadSalesforceSnapshot();
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: "salesforce_unreachable",
        message: `Couldn't reach Salesforce: ${err instanceof Error ? err.message : String(err)}. Try again in a moment.`,
      }, { status: 503 });
    }

    // Resolve the canonical Account row. ID-first; fall back to name-match
    // ONLY if the ID isn't present in the snapshot (shouldn't happen for
    // real-customer URLs but defends against stale links).
    const account = snapshot.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    }

    // Find every WO on this account. Prefer accountId match (canonical);
    // fall back to accountName match for legacy WOs that pre-date the
    // ID-on-WO refactor and don't carry accountId yet.
    const allWos = snapshot.workOrders.filter(
      (w) => w.accountId === account.id ||
        (!w.accountId && w.accountName && w.accountName === account.name)
    );
    const allOpps = snapshot.opportunities.filter(
      (o) => o.accountId === account.id ||
        (!o.accountId && o.accountName && o.accountName === account.name)
    );

    // SCOPE: worker sees only WOs they own
    let visibleWos = allWos;
    let visibleOpps = allOpps;
    if (viewer.scope !== "all") {
      if (!viewer.effectiveUserId) {
        // No SF mapping → enumeration-resistant 404
        return NextResponse.json({ error: "account_not_found" }, { status: 404 });
      }
      visibleWos = allWos.filter((w) => w.ownerId === viewer.effectiveUserId);
      visibleOpps = allOpps.filter((o) => o.ownerId === viewer.effectiveUserId);
      // Worker who has NO WOs at this account → also 404 (they shouldn't see
      // a customer they don't have a relationship with)
      if (visibleWos.length === 0 && visibleOpps.length === 0) {
        return NextResponse.json({ error: "account_not_found" }, { status: 404 });
      }
    }

    const visibleWoIds = visibleWos.map((w) => w.id);

    // Pull the mail timeline — only for WOs the viewer can see. Three
    // queries in parallel; partial failure surfaces in `warnings`.
    const sb = adminClient();
    const errors: string[] = [];
    const events: CustomerMailEvent[] = [];

    if (visibleWoIds.length > 0) {
      const [formsRes, ordersRes, inboxRes] = await Promise.allSettled([
        sb.from("customer_form_tokens")
          .select("token, work_order_id, work_order_number, customer_email, customer_name, sent_at, opened_at, submitted_at, delivery_status")
          .in("work_order_id", visibleWoIds)
          .order("sent_at", { ascending: false, nullsFirst: false }),
        sb.from("supplier_orders")
          .select("id, work_order_id, work_order_number, supplier_name, po_number, sent_to_email, sent_at, acknowledged_at, delivered_at, status, delivery_status")
          .in("work_order_id", visibleWoIds),
        sb.from("inbox_messages")
          .select("id, kind, linked_work_order_id, from_email, from_name, subject, body_text, received_at")
          .in("linked_work_order_id", visibleWoIds)
          .is("archived_at", null)
          .order("received_at", { ascending: false }),
      ]);

      if (formsRes.status === "fulfilled" && !formsRes.value.error) {
        for (const t of (formsRes.value.data ?? []) as Array<{
          token: string; work_order_id: string; work_order_number: string | null;
          customer_email: string; customer_name: string | null;
          sent_at: string | null; opened_at: string | null; submitted_at: string | null;
          delivery_status: string | null;
        }>) {
          const who = t.customer_name ?? t.customer_email;
          if (t.sent_at) {
            events.push({
              id: `form_sent:${t.token}`, kind: "form_sent", at: t.sent_at,
              workOrderId: t.work_order_id, workOrderNumber: t.work_order_number,
              who, label: "Color form sent",
              detail: t.delivery_status === "bounced" ? "⚠ Bounced" : null,
              tone: t.delivery_status === "bounced" ? "warning" : "neutral",
            });
          }
          if (t.opened_at) {
            events.push({
              id: `form_opened:${t.token}`, kind: "form_opened", at: t.opened_at,
              workOrderId: t.work_order_id, workOrderNumber: t.work_order_number,
              who, label: "Customer opened form", detail: null, tone: "neutral",
            });
          }
          if (t.submitted_at) {
            events.push({
              id: `form_submitted:${t.token}`, kind: "form_submitted", at: t.submitted_at,
              workOrderId: t.work_order_id, workOrderNumber: t.work_order_number,
              who, label: "Customer submitted colors", detail: null, tone: "positive",
            });
          }
        }
      } else if (formsRes.status === "fulfilled" && formsRes.value.error) {
        errors.push(`forms: ${formsRes.value.error.message}`);
      }

      if (ordersRes.status === "fulfilled" && !ordersRes.value.error) {
        for (const o of (ordersRes.value.data ?? []) as Array<{
          id: string; work_order_id: string; work_order_number: string | null;
          supplier_name: string; po_number: string; sent_to_email: string;
          sent_at: string | null; acknowledged_at: string | null; delivered_at: string | null;
          status: string; delivery_status: string | null;
        }>) {
          if (o.sent_at) {
            events.push({
              id: `order_sent:${o.id}`, kind: "order_sent", at: o.sent_at,
              workOrderId: o.work_order_id, workOrderNumber: o.work_order_number,
              who: o.supplier_name,
              label: `Order sent to ${o.supplier_name}`,
              detail: `${o.po_number}${o.delivery_status === "bounced" ? " · ⚠ Bounced" : ""}`,
              tone: o.delivery_status === "bounced" ? "warning" : "neutral",
            });
          }
          if (o.acknowledged_at) {
            events.push({
              id: `order_acked:${o.id}`, kind: "order_acknowledged", at: o.acknowledged_at,
              workOrderId: o.work_order_id, workOrderNumber: o.work_order_number,
              who: o.supplier_name,
              label: `${o.supplier_name} acknowledged order`,
              detail: o.po_number, tone: "positive",
            });
          }
          if (o.delivered_at) {
            events.push({
              id: `order_delivered:${o.id}`, kind: "order_delivered", at: o.delivered_at,
              workOrderId: o.work_order_id, workOrderNumber: o.work_order_number,
              who: o.supplier_name,
              label: "Materials delivered",
              detail: `${o.supplier_name} · ${o.po_number}`, tone: "positive",
            });
          }
        }
      } else if (ordersRes.status === "fulfilled" && ordersRes.value.error) {
        errors.push(`orders: ${ordersRes.value.error.message}`);
      }

      if (inboxRes.status === "fulfilled" && !inboxRes.value.error) {
        for (const m of (inboxRes.value.data ?? []) as Array<{
          id: string; kind: string; linked_work_order_id: string | null;
          from_email: string; from_name: string | null;
          subject: string | null; body_text: string | null; received_at: string;
        }>) {
          const isCustomer = m.kind === "customer_reply";
          events.push({
            id: `reply:${m.id}`, kind: "reply_in", at: m.received_at,
            workOrderId: m.linked_work_order_id ?? "",
            workOrderNumber: null,
            who: m.from_name ?? m.from_email,
            label: isCustomer ? "Customer replied" : "Supplier replied",
            detail: m.subject ?? (m.body_text?.slice(0, 80) ?? null),
            tone: "neutral",
          });
        }
      } else if (inboxRes.status === "fulfilled" && inboxRes.value.error) {
        errors.push(`inbox: ${inboxRes.value.error.message}`);
      }
    }

    // Sort timeline newest-first
    events.sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));

    // WO summary for the table — sort by close-date desc with open ones up top.
    // Compute total revenue (visible scope) for the lifetime card.
    const visibleRevenue = visibleWos.reduce((sum, w) => sum + (w.amount ?? 0), 0);

    return NextResponse.json({
      ok: true,
      account: {
        id: account.id,
        name: account.name,
        type: account.type,
        email: account.email,
        phone: account.phone,
        billingStreet: account.billingStreet,
        billingCity: account.billingCity,
        billingState: account.billingState,
        billingPostalCode: account.billingPostalCode,
        accountManagerId: account.accountManagerId,
        primaryContact: account.primaryContact,
        totalLifetimeRevenue: account.totalLifetimeRevenue,
        totalRevenueCFY: account.totalRevenueCFY,
        isBMRetailer: account.isBMRetailer,
        isKeyRelationship: account.isKeyRelationship,
        lastAppointment: account.lastAppointment,
        lastWorkOrderCompleted: account.lastWorkOrderCompleted,
      },
      workOrders: visibleWos.map((w) => ({
        id: w.id,
        workOrderNumber: w.workOrderNumber,
        status: w.status,
        workTypeName: w.workTypeName,
        amount: w.amount,
        ownerId: w.ownerId,
        ownerName: w.ownerName,
        closeDate: w.closeDate,
        createdDate: w.createdDate,
      })).sort((a, b) => {
        // Open-ish statuses first, then by close date desc, then created desc
        const aClosed = /(complete|paid|cancelled|void)/i.test(a.status ?? "");
        const bClosed = /(complete|paid|cancelled|void)/i.test(b.status ?? "");
        if (aClosed !== bClosed) return aClosed ? 1 : -1;
        const ad = a.closeDate ?? a.createdDate;
        const bd = b.closeDate ?? b.createdDate;
        return bd.localeCompare(ad);
      }),
      events,
      summary: {
        workOrderCount: visibleWos.length,
        opportunityCount: visibleOpps.length,
        visibleRevenue,
        eventCount: events.length,
        scopeNote: viewer.scope === "all" ? "admin_full" : "worker_filtered",
        hiddenWoCount: viewer.scope === "all" ? 0 : allWos.length - visibleWos.length,
      },
      warnings: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[admin/customer GET] unhandled:", err);
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
