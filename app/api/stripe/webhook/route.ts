import { NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  claimWebhookEvent,
  stripeWebhookVerifier,
  finishWebhookEvent,
  bookPaidOutPayments,
  markRefunded,
  syncCheckoutSession,
  syncPaymentIntent,
} from "@/lib/payments/service";

export const dynamic = "force-dynamic";
// A payout.paid books every payment in that payout in Salesforce (a Payment In
// and a Payment Term each, several calls apiece). A busy day must not hit the
// default limit partway through; if it ever does, Stripe retries and the
// already-booked ones are skipped, so it resumes rather than double-books.
export const maxDuration = 60;

/**
 * POST /api/stripe/webhook — Stripe telling us a payment moved.
 *
 * Register in Stripe → Developers → Webhooks with these events:
 *   checkout.session.completed
 *   checkout.session.async_payment_succeeded   (ACH cleared)
 *   checkout.session.async_payment_failed      (ACH bounced)
 *   checkout.session.expired
 *   charge.refunded
 *   payment_intent.succeeded                    (card payments on /pay/<token>/card)
 *   payment_intent.processing
 *   payment_intent.payment_failed
 *   payout.paid                                 (money cleared — book it in Salesforce)
 *
 * The signature is checked against STRIPE_WEBHOOK_SECRET on the RAW body —
 * parsing it as JSON first changes the bytes and every signature fails.
 * Anything not created by the Command Center (the old static Payment Link's
 * traffic lands on the same account) is acknowledged and ignored.
 *
 * Returns 500 on a handling error so Stripe retries; the event table makes the
 * retry safe.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "webhook not configured" }, { status: 503 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = stripeWebhookVerifier().constructEvent(raw, signature, secret);
  } catch (err) {
    console.warn("[stripe-webhook] bad signature", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    if (await claimWebhookEvent(event)) return NextResponse.json({ received: true, duplicate: true });
    let outcome = "ok";
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const res = await syncCheckoutSession(event.data.object, event.type);
        if (res.kind === "ignored") outcome = "ok (ignored: " + res.reason + ")";
        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.processing":
      case "payment_intent.payment_failed": {
        // Card-page payments only; a bank payment's PaymentIntent is ignored
        // here and synced through its Checkout Session above.
        const res = await syncPaymentIntent(event.data.object);
        if (res.kind === "ignored") outcome = "ok (ignored: " + res.reason + ")";
        break;
      }
      case "payout.paid": {
        // PPP books Stripe payments once cleared (see lib/payments/payout.ts).
        const res = await bookPaidOutPayments(event.data.object.id);
        outcome = `ok (payout: ${res.inPayout} payment(s), ${res.booked} of ours booked)`;
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        // Partial refunds leave the payment standing; only a full refund flips it.
        if (pi && charge.refunded) await markRefunded(pi);
        break;
      }
      default:
        outcome = "ok (unhandled type)";
    }
    await finishWebhookEvent(event.id, outcome);
    return NextResponse.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[stripe-webhook] handling failed", event.id, event.type, message);
    await finishWebhookEvent(event.id, `error: ${message}`).catch(() => undefined);
    return NextResponse.json({ error: "handling failed" }, { status: 500 });
  }
}
