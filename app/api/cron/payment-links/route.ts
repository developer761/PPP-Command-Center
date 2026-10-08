import { NextResponse } from "next/server";
import { createLinksForOpenWorkOrders, paymentsConfig } from "@/lib/payments/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily: give every open Work Order that needs one a pay link, and write it
 * into Online_Payment_URL__c so the next invoice prints it. New Work Orders get
 * theirs without anyone clicking anything.
 *
 * Off until PAYMENTS_AUTO_LINKS=on — turning it on is part of go-live, after
 * the one-Work-Order pilot. And until the field exists in the org, every write
 * skips (see setWorkOrderPaymentUrl), so even switched on early it does nothing.
 *
 * Bounded per run (100); a backlog clears over a few days. The admin page's
 * "Create links for open Work Orders" button does the same on demand.
 *
 * Bearer-token auth via CRON_SECRET, like the other crons.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (process.env.PAYMENTS_AUTO_LINKS?.trim() !== "on") {
    return NextResponse.json({ ok: true, skipped: "PAYMENTS_AUTO_LINKS is not on" });
  }
  if (paymentsConfig().stripeBlockedReason) {
    // No point publishing links that can't take a payment.
    return NextResponse.json({ ok: true, skipped: "Stripe is not configured for payments" });
  }
  try {
    const r = await createLinksForOpenWorkOrders("cron", 100);
    return NextResponse.json({ ok: true, ...r, failed: r.failed.slice(0, 20) });
  } catch (err) {
    console.error("[cron/payment-links]", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
