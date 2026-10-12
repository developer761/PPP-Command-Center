import { DEMO_TERMS } from "@/lib/payments/demo";
import { buildPaymentSchedule, cardFeeCents, type PaymentSchedule } from "@/lib/payments/schedule";

/**
 * The SIMULATED demo (/demo/payments/*): the customer's screens with nothing
 * behind them — no Stripe, no database, no Salesforce. Used when the site has
 * no Stripe keys, so the flow can be shown before any are set up.
 *
 * All state is in the URL: `p` is how each term has been paid so far, in
 * order, one letter each — c (credit card), d (debit card), b (bank / ACH).
 * "cd" = Deposit by credit, Progress by debit, Final still due. Pure, so the
 * amounts are tested, and refreshing or sharing a step shows the same thing.
 */

export type SimMethod = "c" | "d" | "b";
export const SIM_METHOD_LABEL: Record<SimMethod, string> = {
  c: "Credit card",
  d: "Debit card",
  b: "Bank transfer (ACH)",
};

/** Anything that isn't c/d/b is dropped; never more methods than terms. */
export function parsePaid(raw: string | string[] | undefined): SimMethod[] {
  const s = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? "") : "";
  return (s.split("").filter((ch) => ch === "c" || ch === "d" || ch === "b") as SimMethod[]).slice(0, DEMO_TERMS.length);
}

export const SIM_WO = {
  number: "DEMO-1042",
  contactName: "Demo Customer",
  address: "123 Main Street Huntington, NY 11743",
};

export function simTermCents(i: number): number {
  return Math.round((DEMO_TERMS[i]?.amount ?? 0) * 100);
}

/**
 * The schedule the real pay page would show: card payments are paid, a bank
 * transfer is still clearing (shown as Processing, like the real thing for
 * ~4 business days), and the next term is due.
 */
export function simSchedule(paid: SimMethod[]): PaymentSchedule {
  const terms = DEMO_TERMS.map((t, i) => ({ ...t, id: `T${i + 1}` }));
  const total = terms.reduce((s, t) => s + Math.round((t.amount ?? 0) * 100), 0);
  const settled = paid.reduce((s, m, i) => s + (m === "b" ? 0 : simTermCents(i)), 0);
  const clearing = paid.reduce((s, m, i) => s + (m === "b" ? simTermCents(i) : 0), 0);
  return buildPaymentSchedule({ terms, balanceOwed: (total - settled) / 100, inFlightCents: clearing });
}

/** What one payment costs: the 3% applies to credit cards only. */
export function simCharge(termIndex: number, method: SimMethod): { baseCents: number; feeCents: number; totalCents: number } {
  const baseCents = simTermCents(termIndex);
  const feeCents = method === "c" ? cardFeeCents(baseCents) : 0;
  return { baseCents, feeCents, totalCents: baseCents + feeCents };
}

/** Stripe's published test numbers — shown filled in so nobody types them. */
export const SIM_TEST_CARD = {
  c: { number: "4242 4242 4242 4242", brand: "VISA", kind: "Credit" },
  d: { number: "4000 0566 5566 5556", brand: "VISA", kind: "Debit" },
} as const;

export const SIM_NOTE = "DEMO · Simulated. No card is charged, and nothing is saved or sent to Salesforce.";
