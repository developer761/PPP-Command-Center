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
export function clearedPaymentsInPayout(txns: BalanceTxnLike[]): Map<string, { stripeFeeCents: number | null }> {
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
  // Stripe always charges something to process a card or bank payment, so a
  // total of 0 means the fee wasn't on the transaction — test mode does this,
  // and so does pricing that bills fees monthly instead of per payment. Report
  // "unknown", never $0: a $0 cost makes the 3% look like pure margin.
  // (Seen 2026-10-08: every payment in a real automatic test payout had fee 0.)
  const result = new Map<string, { stripeFeeCents: number | null }>();
  for (const [pi, v] of out) result.set(pi, { stripeFeeCents: v.stripeFeeCents > 0 ? v.stripeFeeCents : null });
  return result;
}

/**
 * The calendar day a payout reached the bank, from its arrival timestamp.
 * Stripe's payout.arrival_date is MIDNIGHT UTC of the arrival day, so read it
 * in UTC. Converting to Eastern first gives 8 PM the evening before, and every
 * Payment In would be dated — and coded "ST"+MMDD — a day early, breaking
 * finance's deposit matching on every payout. (Pre-launch review, 2026-10-08.)
 */
export function depositDateOfArrival(clearedAtIso: string): string {
  return new Date(clearedAtIso).toISOString().slice(0, 10);
}
