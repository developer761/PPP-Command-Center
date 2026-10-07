import { formatCents } from "@/lib/payments/schedule";

/**
 * The Salesforce Transaction__c a successful online payment becomes.
 *
 * Pure, so the exact record is tested and shown on the admin page before
 * anything is ever sent. Modelled on how the office books Stripe payments by
 * hand today (TN-205472 on WO 00313399): record type Payment_In, Method__c
 * 'Stripe', a ReferenceId__c.
 *
 * Description__c starts "Stripe pi_…" — Ruben's convention, which Katie's
 * daily Stripe job uses to recognise an already-booked payment.
 *
 * DIFFERENCES FROM THE HAND-BOOKED ROWS, ON PURPOSE
 *   - ReferenceId__c is Stripe's PaymentIntent id (pi_…) rather than a
 *     hand-typed code like "ST0923", so a Salesforce row can be found in Stripe
 *     and vice versa without guessing.
 *   - Deposited__c is false. The money reaches the bank on Stripe's payout
 *     schedule, not at checkout; whoever marks deposits today still does.
 *
 * OPEN WITH PPP — how the 3% card fee is booked.
 *   Amount__c here is the BASE amount, the part that pays down the Work Order.
 *   The fee is named in Description__c. If Amount__c carried the fee, the
 *   BalanceOwed__c formula (charges − payments in + adjustments) would go
 *   negative by the fee on every card payment. Whether the office wants the fee
 *   as its own row (and on which record type) is their call before write-back
 *   is switched on.
 */

export type SfTransactionInput = {
  recordTypeId: string;
  workOrderId: string;
  /** WorkOrder.Opportunity__c, linked on the record the same way Katie's Stripe job links it. */
  opportunityId?: string | null;
  workOrderNumber: string;
  milestoneLabel: string;
  method: "card" | "ach";
  /** credit / debit / prepaid / unknown, for card payments — so the office can
   *  see why one card payment carried the fee and another didn't. */
  cardFunding?: string | null;
  baseCents: number;
  feeCents: number;
  paymentIntentId: string | null;
  /** YYYY-MM-DD, Eastern — the day the money was confirmed. */
  paidDateEt: string;
};

export function buildSfTransaction(i: SfTransactionInput): Record<string, string | number | boolean | null> {
  const how =
    i.method === "ach"
      ? "bank (ACH)"
      : i.cardFunding && i.cardFunding !== "unknown"
        ? `${i.cardFunding} card`
        : "card";
  const parts = [
    // Ruben's convention, and what Katie's daily Stripe job reads to know a
    // payment is already booked: the Description starts "Stripe pi_…".
    // Without it, her job doesn't see ours as entered.
    i.paymentIntentId ? `Stripe ${i.paymentIntentId}` : null,
    `Online ${how} payment`,
    i.milestoneLabel,
    `WO ${i.workOrderNumber}`,
    i.feeCents > 0 ? `card fee ${formatCents(i.feeCents)} charged on top, not in Amount` : null,
  ].filter(Boolean);

  return {
    RecordTypeId: i.recordTypeId,
    WorkOrder__c: i.workOrderId,
    ...(i.opportunityId ? { Opportunity__c: i.opportunityId } : {}),
    Amount__c: i.baseCents / 100,
    Date__c: i.paidDateEt,
    Method__c: "Stripe",
    ReferenceId__c: i.paymentIntentId ? i.paymentIntentId.slice(0, 50) : null,
    Deposited__c: false,
    Description__c: parts.join(" · ").slice(0, 255),
  };
}
