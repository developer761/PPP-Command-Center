/**
 * Which payments a Stripe payout contains.
 *
 * PPP books a Stripe payment in Salesforce only once it has CLEARED — once it
 * is in a payout on its way to the bank. That is how Katie's daily Stripe
 * finance job gates entries, and the two systems must agree: a card payment
 * that succeeded can still be disputed or refunded before it settles, and a
 * bank payment takes days. So a succeeded payment waits, and the payout.paid
 * webhook books every payment in the payout together.
 *
 * Pure: takes the payout's balance transactions (with `source` expanded to the
 * Charge) and returns the PaymentIntent ids of the money that came IN. Refunds,
 * fees and adjustments in the same payout are not payments to book.
 */

type BalanceTxnLike = {
  type: string;
  /** What Stripe kept for processing this transaction, in cents. */
  fee?: number;
  source: string | { object?: string; payment_intent?: string | { id: string } | null } | null;
};

const PAYMENT_TYPES = new Set(["charge", "payment"]);

export function paymentIntentIdsInPayout(txns: BalanceTxnLike[]): string[] {
  const ids = new Set<string>();
  for (const t of txns) {
    if (!PAYMENT_TYPES.has(t.type)) continue;
    const src = t.source;
    if (!src || typeof src === "string") continue;
    const pi = typeof src.payment_intent === "string" ? src.payment_intent : src.payment_intent?.id;
    if (pi) ids.add(pi);
  }
  return [...ids];
}

/**
 * Same payments, with what Stripe charged PPP to process each — for the
 * Payments tab's "fee collected vs. what cards cost us". A payment split over
 * more than one balance transaction has its fees summed.
 */
export function clearedPaymentsInPayout(txns: BalanceTxnLike[]): Map<string, { stripeFeeCents: number }> {
  const out = new Map<string, { stripeFeeCents: number }>();
  for (const t of txns) {
    if (!PAYMENT_TYPES.has(t.type)) continue;
    const src = t.source;
    if (!src || typeof src === "string") continue;
    const pi = typeof src.payment_intent === "string" ? src.payment_intent : src.payment_intent?.id;
    if (!pi) continue;
    const prev = out.get(pi)?.stripeFeeCents ?? 0;
    out.set(pi, { stripeFeeCents: prev + (t.fee ?? 0) });
  }
  return out;
}
