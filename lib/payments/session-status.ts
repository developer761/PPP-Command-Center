/**
 * Map what Stripe says about a Checkout Session onto our payment status.
 *
 * Pure, so the ACH case — the one that is easy to get wrong — is tested. A
 * card payment is 'paid' the moment checkout completes. An ACH payment
 * completes checkout with payment_status 'unpaid' and only becomes 'paid' days
 * later (checkout.session.async_payment_succeeded). Treating "checkout
 * complete" as "money received" would book an ACH payment that can still
 * bounce.
 */

export type OurStatus = "open" | "processing" | "succeeded" | "failed" | "expired";

export function statusFromSession(
  session: { status: string | null; payment_status: string | null },
  eventType?: string,
): OurStatus {
  if (eventType === "checkout.session.async_payment_failed") return "failed";
  if (eventType === "checkout.session.expired" || session.status === "expired") return "expired";
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") return "succeeded";
  if (session.status === "complete") return "processing";
  return "open";
}

/**
 * Stripe can deliver events out of order (an 'expired' after a 'completed' is
 * not possible, but a late 'completed' after we already saw 'succeeded' is).
 * Never move a payment backwards.
 */
const RANK: Record<string, number> = { open: 0, expired: 1, processing: 2, failed: 3, succeeded: 4, refunded: 5 };
export function isForwardMove(from: string, to: string): boolean {
  if (from === to) return false;
  // A failed ACH can only have been 'processing'; a succeeded one never fails.
  if (to === "failed") return from === "processing" || from === "open";
  return (RANK[to] ?? 0) > (RANK[from] ?? 0);
}

/** Marker put on every Checkout Session we create. PPP's Stripe account also
 *  carries the old static Payment Link's traffic; the webhook ignores anything
 *  without this, so those payments are never touched. */
export const PPP_PAY_SOURCE = "command-center-pay";

/**
 * A PaymentIntent's status, for card payments made on our own page (no
 * Checkout Session). 'requires_action' is the bank's 3-D Secure check —
 * still open, the customer is mid-way. A card that is declined comes back
 * as requires_payment_method.
 */
export function statusFromPaymentIntent(status: string): OurStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "processing":
      return "processing";
    case "requires_payment_method":
    case "canceled":
      return "failed";
    default:
      return "open";
  }
}

/** Marks a PaymentIntent created by the card page, as opposed to one Checkout
 *  created for a bank payment (which carries the same source marker and is
 *  synced through its Checkout Session instead). */
export const CARD_ELEMENT_FLOW = "card_element";
