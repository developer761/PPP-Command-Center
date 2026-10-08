import { formatCents } from "@/lib/payments/schedule";

/**
 * The Salesforce Transaction__c a successful online payment becomes.
 *
 * Pure, so the exact record is tested and shown on the admin page before
 * anything is ever sent. It follows the finance team's conventions exactly,
 * because their bank reconciliation runs on them (Katie, after sitting with
 * Ruben, 2026-10-08):
 *
 *   ReferenceId__c  "ST" + MMDD of the DEPOSIT — the day the Stripe payout
 *                   reaches the bank. A deposit batch code: every Stripe
 *                   payment in that day's payout shares it ("ST1008" ×6 in
 *                   production on 10/8), which is how a Salesforce entry is
 *                   matched to the bank statement. Not the pi_ id.
 *   Date__c         the deposit date.
 *   Deposited__c    true when booked from the payout (it is in the bank);
 *                   false if an admin books one early, before its payout.
 *   Description__c  starts "Stripe pi_…" — Ruben's convention, and what Katie's
 *                   daily Stripe job and our own duplicate check look for.
 *   Amount__c       the BASE amount only. The 3% credit-card fee is never in
 *                   it (it would push BalanceOwed__c negative); it's named in
 *                   the Description and tracked on the Payments tab.
 */

/** "ST" + MMDD of a YYYY-MM-DD deposit date — Ruben's Stripe deposit code. */
export function stripeDepositReference(dateEt: string): string {
  const [, mm, dd] = dateEt.split("-");
  return `ST${mm}${dd}`;
}

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
  /** Booked from a Stripe payout (the money is in the bank) rather than early
   *  by an admin. Sets Deposited__c, and paidDateEt is then the deposit date. */
  fromPayout?: boolean;
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
    ReferenceId__c: stripeDepositReference(i.paidDateEt),
    Deposited__c: i.fromPayout === true,
    Description__c: parts.join(" · ").slice(0, 255),
  };
}
