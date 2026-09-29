import { describe, expect, it } from "vitest";
import { paymentIntentIdsInPayout } from "@/lib/payments/payout";

// Shaped like stripe.balanceTransactions.list({ payout, expand: ["data.source"] }).
describe("paymentIntentIdsInPayout — which payments cleared in this payout", () => {
  it("card charges and bank (ACH) payments both count", () => {
    expect(
      paymentIntentIdsInPayout([
        { type: "charge", source: { object: "charge", payment_intent: "pi_card" } },
        { type: "payment", source: { object: "charge", payment_intent: { id: "pi_ach" } } },
      ]),
    ).toEqual(["pi_card", "pi_ach"]);
  });

  it("refunds, Stripe fees and the payout line itself are not payments to book", () => {
    expect(
      paymentIntentIdsInPayout([
        { type: "refund", source: { object: "refund", payment_intent: "pi_refunded" } },
        { type: "stripe_fee", source: null },
        { type: "payout", source: "po_123" },
        { type: "adjustment", source: { object: "dispute" } },
      ]),
    ).toEqual([]);
  });

  it("a charge with no PaymentIntent (e.g. the old API) is skipped, not crashed on", () => {
    expect(paymentIntentIdsInPayout([{ type: "charge", source: { object: "charge", payment_intent: null } }])).toEqual([]);
  });

  it("the same payment twice in a listing is booked once", () => {
    const t = { type: "charge", source: { object: "charge", payment_intent: "pi_x" } };
    expect(paymentIntentIdsInPayout([t, t])).toEqual(["pi_x"]);
  });

  it("an unexpanded source (just an id) can't be matched — skipped", () => {
    expect(paymentIntentIdsInPayout([{ type: "charge", source: "ch_123" }])).toEqual([]);
  });
});
