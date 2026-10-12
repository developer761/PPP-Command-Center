import { randomBytes } from "node:crypto";
import { readPaymentsConfig } from "@/lib/payments/config";
import type { PaymentTermInput } from "@/lib/payments/schedule";

/**
 * The sales demo: a made-up job anyone with the link can pay with Stripe TEST
 * cards, end to end, on the real site — for showing the flow to PPP without a
 * real customer's name, address or balance ever being on a shareable link.
 *
 * Safe by construction:
 *   - ON only while PAYMENTS_DEMO=on AND the Stripe key is a TEST key. The day
 *     the live key goes in, every demo link stops working by itself: a demo
 *     can never take real money.
 *   - Demo Work Order Ids start "0WODEMO", which no Salesforce record can
 *     (Ids are base-62 from the org, and WorkOrder's prefix is 0WO followed by
 *     the org's own characters). The Salesforce layer answers them from the
 *     fixture below and never queries or writes for them.
 *   - Nothing about a demo payment is ever booked in Salesforce.
 */

export const DEMO_WO_PREFIX = "0WODEMO";

export function isDemoWorkOrderId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(DEMO_WO_PREFIX);
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh 18-char demo Id — one per "Start the demo", so every run starts unpaid. */
export function newDemoWorkOrderId(): string {
  const bytes = randomBytes(11);
  return DEMO_WO_PREFIX + Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join("");
}

export function demoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAYMENTS_DEMO?.trim() === "on" && readPaymentsConfig(env).stripeMode === "test";
}

/** "DEMO-7QK2" — reads as obviously not a real invoice number. */
export function demoWorkOrderNumber(id: string): string {
  return `DEMO-${id.slice(-4).toUpperCase()}`;
}

/** $5,000 job, 30 / 40 / 30 — the shape of a typical PPP job. */
export const DEMO_TERMS: Omit<PaymentTermInput, "id">[] = [
  { type: "Deposit", order: 1, amount: 1500, percent: 30, paidInFull: false },
  { type: "Progress", order: 2, amount: 2000, percent: 40, paidInFull: false },
  { type: "Final", order: 3, amount: 1500, percent: 30, paidInFull: false },
];

export function demoWorkOrder(id: string) {
  return {
    id,
    number: demoWorkOrderNumber(id),
    status: "In Progress",
    balanceOwed: 5000,
    totalCharges: 5000,
    totalPaymentsIn: 0,
    opportunityId: null,
    contactName: "Demo Customer",
    contactEmail: null,
    street: "123 Main Street",
    city: "Huntington",
    state: "NY",
    postalCode: "11743",
    terms: DEMO_TERMS.map((t, i) => ({ ...t, id: `${id}-T${i + 1}` })),
  };
}

/** Stripe's built-in test cards, as payment methods the server can attach. */
export const DEMO_TEST_CARDS = {
  credit: "pm_card_visa",
  debit: "pm_card_visa_debit",
} as const;
export type DemoCard = keyof typeof DEMO_TEST_CARDS;

/** The strip across the top of every demo pay page. */
export const DEMO_NOTE = "DEMO · A made-up job paid with Stripe test cards. No real money moves, and nothing goes to Salesforce.";
