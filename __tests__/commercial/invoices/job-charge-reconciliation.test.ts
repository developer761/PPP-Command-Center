import { describe, it, expect } from "vitest";
import { reconcileJobCharges } from "@/lib/commercial/invoices/invoice-pdf-data";

/**
 * The Financial Summary on the invoice PDF reconciles the whole job:
 *
 *   original contract + approved change orders + sales tax billed
 *     − payments received
 *     = current balance
 *
 * The bug this guards against: the charge side was the contract and its change
 * orders ONLY — both pre-tax — while the credit side was payments, which settle
 * `total_cents = subtotal + ROUND(subtotal * tax_pct / 100)` (migration 042) and
 * so carry sales tax. Every payment therefore wrote off more than it should
 * have, and the PDF that goes to the GC's AP department understated what was
 * owed by exactly the tax collected — then went negative and announced a
 * "Credit Balance" on a job that was paid to the cent.
 */
describe("job charge reconciliation on the invoice PDF", () => {
  const TAX_PCT = 8.625;
  const tax = (subtotalCents: number) => Math.round((subtotalCents * TAX_PCT) / 100);

  it("lands on exactly zero when a taxable job is fully billed and fully paid", () => {
    const contract = 10_000_000; // $100,000
    const billedTax = tax(contract);
    const { currentBalanceCents } = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: 0,
      salesTaxBilledCents: billedTax,
      paymentsTotalCents: contract + billedTax, // payments settle tax-inclusive totals
    });
    expect(currentBalanceCents).toBe(0);
  });

  it("never reports a credit on a fully-settled job (the regression)", () => {
    const contract = 10_000_000;
    const billedTax = tax(contract);
    const withTaxOnChargeSide = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: 0,
      salesTaxBilledCents: billedTax,
      paymentsTotalCents: contract + billedTax,
    });
    // The old behaviour, reproduced by dropping tax from the charge side.
    const withoutTaxOnChargeSide = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: 0,
      salesTaxBilledCents: 0,
      paymentsTotalCents: contract + billedTax,
    });
    expect(withoutTaxOnChargeSide.currentBalanceCents).toBe(-billedTax);
    expect(withTaxOnChargeSide.currentBalanceCents).toBeGreaterThanOrEqual(0);
  });

  it("leaves the unbilled contract owing when only part of the job is billed", () => {
    const contract = 10_000_000;
    const billedSubtotal = 5_000_000;
    const billedTax = tax(billedSubtotal);
    const { totalChargesCents, currentBalanceCents } = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: 0,
      salesTaxBilledCents: billedTax,
      paymentsTotalCents: billedSubtotal + billedTax,
    });
    expect(totalChargesCents).toBe(contract + billedTax);
    // Exactly the half of the contract not yet billed — no tax on unbilled work.
    expect(currentBalanceCents).toBe(contract - billedSubtotal);
  });

  it("carries approved change orders and their tax", () => {
    const contract = 10_000_000;
    const co = 2_000_000;
    const billedTax = tax(contract + co);
    const { totalChargesCents, currentBalanceCents } = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: co,
      salesTaxBilledCents: billedTax,
      paymentsTotalCents: contract + co + billedTax,
    });
    expect(totalChargesCents).toBe(contract + co + billedTax);
    expect(currentBalanceCents).toBe(0);
  });

  it("is unchanged on a tax-exempt job", () => {
    const contract = 10_000_000;
    const { totalChargesCents, currentBalanceCents } = reconcileJobCharges({
      originalCents: contract,
      changeOrderTotalCents: 0,
      salesTaxBilledCents: 0,
      paymentsTotalCents: 4_000_000,
    });
    expect(totalChargesCents).toBe(contract);
    expect(currentBalanceCents).toBe(6_000_000);
  });
});
