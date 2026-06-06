import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { sendCustomerFormInvite, sendEmail } from "@/lib/email/resend";
import { markSent } from "@/lib/customer-form/tokens";
import { prefetchFormRenderData } from "@/lib/customer-form/render-data";

/**
 * Re-fire a previously bounced (or otherwise failed) send. Wired to the
 * "Re-send" button on bounced rows in the Mail Hub's Sent view.
 *
 *   POST /api/admin/sent/resend
 *   body: { id: "form:<token>" | "order:<uuid>" }
 *
 * For form invites: re-builds the same form URL using the existing token
 * (the token is still valid — only the delivery failed). New Resend
 * message id stamped on the row so future events thread correctly.
 *
 * For supplier orders: re-fires the original draft_body to the same
 * sent_to_email. PO number stays the same — the order didn't change, just
 * the delivery vehicle. A new Resend message id replaces the old one so
 * the events webhook can update delivery_status for the retry.
 *
 * Scope: viewer must own the linked WO (or be admin). Same defense as the
 * inbox POST handler.
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(request: Request) {
  try {
    const viewer = await resolveViewer({});
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: { id?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_json" }, { status: 400 });
    }
    if (!body.id || typeof body.id !== "string") {
      return NextResponse.json({ error: "missing_id" }, { status: 400 });
    }

    // Parse the composite id from the Sent view ("form:<token>" or "order:<uuid>")
    const [kindTag, ref] = body.id.split(":", 2);
    if (!ref || (kindTag !== "form" && kindTag !== "order")) {
      return NextResponse.json({ error: "invalid_id_format" }, { status: 400 });
    }

    const sb = adminClient();

    if (kindTag === "form") {
      // Re-fire a customer-form invite.
      const { data: row, error } = await sb
        .from("customer_form_tokens")
        .select("token, work_order_id, work_order_number, customer_email, customer_name, expires_at, sent_at, resend_message_id_invite")
        .eq("token", ref)
        .maybeSingle();
      if (error || !row) {
        return NextResponse.json({ error: "token_not_found" }, { status: 404 });
      }

      // SCOPE CHECK FIRST — before any state-revealing branch (expired vs
      // not). Without this order, a worker who guesses a token can probe
      // expiry status (409 expired vs other code = exists, not yours) before
      // hitting the ownership gate. Now: every non-owned token returns the
      // same 404, regardless of its real state.
      if (viewer.scope !== "all") {
        if (!viewer.effectiveUserId) {
          return NextResponse.json({ error: "token_not_found" }, { status: 404 });
        }
        const snapshot = await loadSalesforceSnapshot();
        const ownsWo = snapshot.workOrders.some(
          (w) => w.id === row.work_order_id && w.ownerId === viewer.effectiveUserId
        );
        if (!ownsWo) {
          return NextResponse.json({ error: "token_not_found" }, { status: 404 });
        }
      }

      // Idempotency: if we sent this same form invite within the last 5
      // minutes AND already have a Resend message id, treat the click as a
      // duplicate (browser retry, double-click race, etc.) — return the
      // existing message id instead of firing another email. Customer
      // doesn't get spammed; admin sees the same UX response.
      if (
        row.sent_at &&
        row.resend_message_id_invite &&
        Date.now() - new Date(row.sent_at).getTime() < 5 * 60_000
      ) {
        return NextResponse.json({
          ok: true,
          kind: "form_invite",
          deduped: true,
          resendMessageId: row.resend_message_id_invite,
        });
      }

      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return NextResponse.json({
          error: "token_expired",
          message: "Token has expired. Send a fresh color form from the materials page.",
        }, { status: 409 });
      }

      // Extend the expiry so the customer gets a fresh 24h to respond, even
      // if the original token was about to die (audit 2026-06-04: a resend
      // that buys the customer 30 minutes is worse than no resend at all).
      // Cap at the original natural cutoff (24h before WO start) — never
      // re-extend past the rep's deadline. When `original` is already past
      // "now + 24h" (plenty of time left), keep it unchanged to avoid the
      // pointless write.
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const desiredExpiry = Date.now() + ONE_DAY_MS;
      const originalExpiry = row.expires_at ? new Date(row.expires_at).getTime() : 0;
      const cappedExpiry = originalExpiry > 0 ? Math.min(desiredExpiry, originalExpiry) : desiredExpiry;
      let extendedExpiresAt: string | null = null;
      if (originalExpiry === 0 || cappedExpiry > originalExpiry) {
        // Safe to extend — either no expiry on file (legacy row) or the
        // computed cap is later than what's stored (customer was losing time
        // off the front of the window). Push the row forward.
        const newIso = new Date(cappedExpiry).toISOString();
        const { error: updateErr } = await sb
          .from("customer_form_tokens")
          .update({ expires_at: newIso })
          .eq("token", row.token);
        if (updateErr) {
          // Don't fail the resend — log + continue with stale expiry. The
          // customer still gets the email; only the cutoff display is off.
          console.warn(`[resend] couldn't extend expires_at for token ${row.token.slice(0, 8)}…:`, updateErr.message);
        } else {
          extendedExpiresAt = newIso;
        }
      }

      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
        new URL(request.url).origin;
      const formUrl = `${baseUrl}/select/${row.token}`;

      const send = await sendCustomerFormInvite({
        to: row.customer_email,
        customerName: row.customer_name,
        workOrderNumber: row.work_order_number,
        formUrl,
      });
      if (!send.ok) {
        return NextResponse.json({
          ok: false,
          error: "email_send_failed",
          message: send.error,
        }, { status: 502 });
      }

      // Stamp the new resend_message_id (when present) as "sent" — Resend's
      // 200 means accepted, not delivered; the events webhook promotes it. This
      // also resets the row off its old "bounced" status so the next delivery
      // event updates THIS message, not the stale one.
      await markSent(row.token, "sent", send.id ?? undefined);

      // Pre-warm the customer's render-data cache so when they click the
      // resent link the page loads from cache (~50ms) instead of a cold
      // SF round-trip (~1-3s). Fire-and-forget — failures are logged but
      // don't affect the resend response.
      prefetchFormRenderData(row.work_order_id);

      return NextResponse.json({
        ok: true,
        kind: "form_invite",
        resendMessageId: send.id,
        formUrl,
        expiresAt: extendedExpiresAt ?? row.expires_at,
        expiryExtended: extendedExpiresAt !== null,
      });
    }

    // kindTag === "order"
    const { data: order, error } = await sb
      .from("supplier_orders")
      .select("id, work_order_id, supplier_name, po_number, sent_to_email, draft_body, work_order_number, sent_at, resend_message_id")
      .eq("id", ref)
      .maybeSingle();
    if (error || !order) {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }

    if (viewer.scope !== "all") {
      if (!viewer.effectiveUserId) {
        return NextResponse.json({ error: "order_not_found" }, { status: 404 });
      }
      const snapshot = await loadSalesforceSnapshot();
      const ownsWo = snapshot.workOrders.some(
        (w) => w.id === order.work_order_id && w.ownerId === viewer.effectiveUserId
      );
      if (!ownsWo) {
        return NextResponse.json({ error: "order_not_found" }, { status: 404 });
      }
    }

    // Idempotency: if we sent this same supplier order within the last 5
    // minutes AND have a Resend message id, treat the click as a duplicate
    // and return the existing id instead of firing another email. Suppliers
    // don't get double-orders; admin sees the same response.
    const orderRow = order as typeof order & { sent_at?: string | null; resend_message_id?: string | null };
    if (
      orderRow.sent_at &&
      orderRow.resend_message_id &&
      Date.now() - new Date(orderRow.sent_at).getTime() < 5 * 60_000
    ) {
      return NextResponse.json({
        ok: true,
        kind: "supplier_order",
        deduped: true,
        resendMessageId: orderRow.resend_message_id,
        poNumber: order.po_number,
      });
    }

    // Synthesize subject — supplier_orders doesn't store it separately; the
    // builder regenerates from PO + supplier on each send, so we do the same.
    const subject = `PPP Order ${order.po_number} — re-send (${order.supplier_name})`;
    const send = await sendEmail({
      to: order.sent_to_email,
      subject,
      text: order.draft_body,
      replyTo: process.env.RESEND_FROM_ADDRESS || undefined,
      tags: [
        { name: "kind", value: "supplier_order" },
        { name: "po", value: order.po_number },
        { name: "retry", value: "1" },
      ],
    });
    if (!send.ok) {
      return NextResponse.json({
        ok: false,
        error: "email_send_failed",
        message: send.error,
      }, { status: 502 });
    }

    // Reset row to a fresh "sent" state — delivery_status clears so the
    // events webhook can re-populate it. resend_message_id replaced so
    // bounces/deliveries thread to THIS retry, not the old failed send.
    await sb
      .from("supplier_orders")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        resend_message_id: send.id,
        delivery_status: null,
        delivery_status_updated_at: null,
        failure_reason: null,
      })
      .eq("id", order.id);

    return NextResponse.json({
      ok: true,
      kind: "supplier_order",
      resendMessageId: send.id,
      poNumber: order.po_number,
    });
  } catch (err) {
    console.error("[admin/sent/resend POST] unhandled:", err);
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
