/**
 * THE VENDOR WROTE BACK AND NOBODY WAS TOLD.
 *
 * Kate, 2026-10-14: "how do the guys view vendor replies to the materials
 * order? Are they in the hub only or are they emailed to the guys?"
 *
 * Tracing it to answer her turned up the real gap. The plumbing is fine —
 * a reply threads into Mail against the exact order and PO it answers, and
 * reps see their own work orders — but NOTHING announced it. The only signal
 * was the unread count on the Mail item in the sidebar, which you see once
 * you are already in the hub. A vendor writing "we're out of Revere Pewter"
 * sat there until somebody wandered past.
 *
 * That is the worst shape a message can have: it arrived, it was stored
 * correctly, and the person waiting on it had no reason to look.
 *
 * ── WHO, AND WHY NOT EVERYONE ───────────────────────────────────────────
 *
 * The person who sent the order. They chose the vendor, they picked the
 * date, and the reply is a direct answer to something they did — so this is
 * transactional mail, not a subscription, and it goes to their PPP address
 * without an opt-in. They are already CC'd on the outbound order for exactly
 * the same reason (Katie, 2026-06-03).
 *
 * Admins are the fallback, not the default. Copying every admin on every
 * vendor reply is how a notification becomes wallpaper, and the hub's triage
 * queue already exists for mail nobody can place. They are used only when
 * the order has no usable sender — a deactivated account, or a row written
 * before created_by_user_id was captured — because the alternative there is
 * telling nobody.
 *
 * ── NEVER THROWS ────────────────────────────────────────────────────────
 *
 * Called from the Resend inbound webhook AFTER the message is safely
 * stored. A failure here must not make the webhook return non-200, or
 * Resend retries and the same reply lands twice. Every path logs instead.
 */
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type SupplierReplyInput = {
  /** supplier_orders.id the reply threaded to. */
  orderId: string;
  /** For the link — the Mail Hub filters by work order. */
  workOrderId: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  /** Plain-text body, for the first line of the preview. */
  bodyText: string | null;
};

/** First meaningful line of a reply, with the quoted thread left behind. */
export function replyPreview(bodyText: string | null | undefined, max = 180): string {
  const lines = (bodyText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Quoted history and the "On <date> X wrote:" header say nothing about
    // what the vendor actually replied, and they are most of the body.
    .filter((l) => l && !l.startsWith(">") && !/^on .{0,80}wrote:$/i.test(l));
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function notifySupplierReply(input: SupplierReplyInput): Promise<void> {
  try {
    const sb = adminClient();

    const { data: order, error: orderErr } = await sb
      .from("supplier_orders")
      .select("id, po_number, supplier_name, work_order_number, created_by_user_id")
      .eq("id", input.orderId)
      .maybeSingle();
    if (orderErr) {
      console.warn(`[supplier-reply] order lookup failed for ${input.orderId}: ${orderErr.message}`);
      return;
    }
    if (!order) {
      console.warn(`[supplier-reply] no supplier_orders row ${input.orderId} — nobody notified`);
      return;
    }

    const senderId = (order.created_by_user_id as string | null) ?? null;
    let recipients: Array<{ user_id: string; email: string | null }> = [];

    if (senderId) {
      const { data: p } = await sb
        .from("profiles")
        .select("user_id, email, is_active")
        .eq("user_id", senderId)
        .maybeSingle();
      if (p && p.is_active !== false) {
        recipients = [{ user_id: p.user_id as string, email: (p.email as string | null) ?? null }];
      }
    }

    if (recipients.length === 0) {
      // No usable sender. Telling nobody is the one outcome worth avoiding.
      const { data: admins } = await sb
        .from("profiles")
        .select("user_id, email")
        .eq("is_admin", true)
        .eq("is_active", true);
      recipients = (admins ?? []).map((a) => ({
        user_id: a.user_id as string,
        email: (a.email as string | null) ?? null,
      }));
      console.warn(
        `[supplier-reply] order ${input.orderId} has no active sender — falling back to ${recipients.length} admin(s)`
      );
    }
    if (recipients.length === 0) {
      console.warn(`[supplier-reply] no recipients at all for order ${input.orderId}`);
      return;
    }

    const who = input.fromName?.trim() || (order.supplier_name as string | null) || input.fromEmail;
    const po = (order.po_number as string | null) ?? null;
    const woNum = (order.work_order_number as string | null) ?? null;
    const title = `${who} replied${po ? ` about PO ${po}` : ""}`;
    const preview = replyPreview(input.bodyText);
    const body = preview || (input.subject ?? "").trim() || "Open Mail to read the reply.";
    // Straight to the thread, filtered to this job — not a general inbox the
    // reader then has to search.
    const link = input.workOrderId
      ? `/dashboard/inbox?workOrderId=${encodeURIComponent(input.workOrderId)}`
      : "/dashboard/inbox";

    const { error: insErr } = await sb.from("notifications").insert(
      recipients.map((r) => ({
        recipient_user_id: r.user_id,
        kind: "supplier_reply",
        work_order_id: input.workOrderId,
        work_order_number: woNum,
        customer_name: null,
        title,
        body,
        link,
      }))
    );
    if (insErr) {
      console.warn(`[supplier-reply] bell insert failed for order ${input.orderId}: ${insErr.message}`);
    }

    // The email. Transactional — a direct answer to an order this person
    // sent — so it goes to their PPP address without an opt-in, the same
    // way they are CC'd on the order itself.
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    for (const r of recipients) {
      if (!r.email) continue;
      const res = await sendEmail({
        to: r.email,
        subject: `${who} replied${po ? ` — PO ${po}` : ""}${woNum ? ` (WO ${woNum})` : ""}`,
        text: [
          `${who} replied to the materials order${po ? ` for PO ${po}` : ""}.`,
          woNum ? `Work order: ${woNum}` : null,
          `From: ${input.fromEmail}`,
          input.subject ? `Subject: ${input.subject}` : null,
          "",
          preview || "(no text in the reply)",
          "",
          base ? `Read it: ${base}${link}` : "Open Mail in the Command Center to read it.",
        ]
          .filter((l) => l !== null)
          .join("\n"),
      });
      // sendEmail RETURNS {ok:false} rather than throwing.
      if (!res?.ok) {
        console.error(
          `[supplier-reply] email to ${r.email} failed for order ${input.orderId}: ${"error" in (res ?? {}) ? (res as { error?: string }).error : "unknown"}`
        );
      }
    }
  } catch (err) {
    console.error(
      `[supplier-reply] threw for order ${input.orderId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}
