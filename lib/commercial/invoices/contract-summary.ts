import type { ChangeOrderStatus } from "@/lib/commercial/change-orders/constants";

/**
 * The invoice PDF's "Financial Summary" — Brendan's format, via Stephanie
 * (2026-08-19).
 *
 * His sample is not a line-item invoice, it is a CONTRACT POSITION statement:
 *
 *   Original Contract Total
 *     CO #1 — …
 *     CO #2 — …
 *   Change Order Total
 *   Total Customer Charges
 *     Payment - 6/14/26
 *     Payment - 7/28/26
 *   Payments Received Total
 *   Current Balance
 *
 * …and only THEN what this particular invoice bills.
 *
 * Pure and separate from `invoice-pdf-data` on purpose: this is the arithmetic
 * a GC's AP department reconciles against, and it was previously computed
 * inline in a server-only, database-bound module where nothing could test it.
 */

export type ContractSummaryChangeOrder = {
  number: number;
  title: string;
  /** SIGNED — negative is a deduct/credit CO. */
  amountCents: number;
  status: ChangeOrderStatus;
};

export type ContractSummaryPayment = { dateIso: string | null; amountCents: number };

export type ContractSummaryInput = {
  /** Original contract base, EXCLUDING change orders (getEffectiveContractBaseCents). */
  originalContractCents: number;
  /** Every change order on the job, any status. Filtering happens here. */
  changeOrders: ContractSummaryChangeOrder[];
  /** One entry per LIVE invoice on the job — draft and void already excluded
   *  by the caller, because those bill nothing and charge no tax. */
  invoices: { subtotalCents: number; totalCents: number }[];
  /** Every payment recorded against those live invoices. */
  payments: ContractSummaryPayment[];
};

export type ContractSummary = {
  originalCents: number;
  /** APPROVED only. */
  changeOrders: { number: number; title: string; amountCents: number }[];
  changeOrderTotalCents: number;
  /** Original contract + approved COs. Pre-tax, exactly as Brendan's sample. */
  totalChargesCents: number;
  /** Sales tax invoiced on this job so far. 0 on an exempt job, which is why
   *  an exempt job prints character-for-character like the sample. */
  taxBilledToDateCents: number;
  /** Oldest first. */
  payments: ContractSummaryPayment[];
  paymentsTotalCents: number;
  /** Charges + tax billed − payments. Negative = the GC is in credit. */
  currentBalanceCents: number;
  /** Change orders the GC has not answered. Deliberately OUT of the charges. */
  pendingCoTotalCents: number;
};

/**
 * Build the summary, or null when there is no contract to reconcile against.
 *
 * Returning null on a zero is deliberate: printing "Original Contract Total
 * $0.00" above a real invoice reads as a data error rather than as "no bid
 * recorded", so the block is omitted and the invoice renders as a plain
 * line-item bill.
 */
export function buildContractSummary(input: ContractSummaryInput): ContractSummary | null {
  const originalCents = Math.max(0, Math.round(input.originalContractCents));
  if (originalCents <= 0) return null;

  // APPROVED only. A pending CO is money the GC has not agreed to, and putting
  // it in "Total Customer Charges" would bill them for it.
  const approved = input.changeOrders.filter((c) => c.status === "approved");
  const changeOrderTotalCents = approved.reduce((n, c) => n + c.amountCents, 0);
  const totalChargesCents = originalCents + changeOrderTotalCents;

  // TAX. The sample shows no tax because that job is capital-improvement
  // exempt. But "Total Customer Charges" is pre-tax while a PAYMENT arrives
  // tax-inclusive, so on a taxable job subtracting one from the other
  // understated the balance by every dollar of tax already collected — the GC
  // would be told they owed less than they do, on the document their AP
  // department reconciles from. Tax invoiced to date is added to the charges
  // so both sides of the subtraction are on the same basis. Zero on an exempt
  // job, so that job still prints exactly like Brendan's sample.
  const taxBilledToDateCents = input.invoices.reduce(
    (n, i) => n + Math.max(0, i.totalCents - i.subtotalCents),
    0
  );

  // Oldest first, and undated payments lead rather than being dropped.
  const payments = [...input.payments].sort((a, b) =>
    String(a.dateIso ?? "").localeCompare(String(b.dateIso ?? ""))
  );
  const paymentsTotalCents = payments.reduce((n, pm) => n + pm.amountCents, 0);

  const pendingCoTotalCents = input.changeOrders
    .filter((c) => c.status === "pending")
    .reduce((n, c) => n + c.amountCents, 0);

  return {
    originalCents,
    changeOrders: approved.map((c) => ({
      number: c.number,
      title: c.title,
      amountCents: c.amountCents,
    })),
    changeOrderTotalCents,
    totalChargesCents,
    taxBilledToDateCents,
    payments,
    paymentsTotalCents,
    currentBalanceCents: totalChargesCents + taxBilledToDateCents - paymentsTotalCents,
    pendingCoTotalCents,
  };
}
