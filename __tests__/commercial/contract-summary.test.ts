import { describe, it, expect } from "vitest";
import {
  buildContractSummary,
  type ContractSummaryInput,
} from "@/lib/commercial/invoices/contract-summary";

/**
 * The invoice PDF's Financial Summary — Brendan's format via Stephanie
 * (2026-08-19). This is the block a GC's AP department reconciles against, so
 * every branch of the arithmetic gets a case.
 */

function input(over: Partial<ContractSummaryInput> = {}): ContractSummaryInput {
  return {
    originalContractCents: 100_000_00,
    changeOrders: [],
    invoices: [],
    payments: [],
    ...over,
  };
}

describe("buildContractSummary", () => {
  it("is omitted entirely when there is no contract on file", () => {
    // Printing "Original Contract Total $0.00" above a real invoice reads as a
    // data error, not as "no bid recorded".
    expect(buildContractSummary(input({ originalContractCents: 0 }))).toBeNull();
    expect(buildContractSummary(input({ originalContractCents: -5_000_00 }))).toBeNull();
  });

  it("reconciles contract + approved COs − payments", () => {
    const s = buildContractSummary(
      input({
        changeOrders: [
          { number: 1, title: "Extra coat", amountCents: 5_000_00, status: "approved" },
          { number: 2, title: "Deduct unused doors", amountCents: -1_000_00, status: "approved" },
        ],
        invoices: [{ subtotalCents: 40_000_00, totalCents: 40_000_00 }],
        payments: [{ dateIso: "2026-07-01", amountCents: 40_000_00 }],
      })
    )!;
    expect(s.changeOrderTotalCents).toBe(4_000_00);
    expect(s.totalChargesCents).toBe(104_000_00);
    expect(s.paymentsTotalCents).toBe(40_000_00);
    expect(s.currentBalanceCents).toBe(64_000_00);
  });

  it("keeps PENDING change orders out of the charges, but reports them", () => {
    // Billing for scope the GC hasn't agreed to is the one thing an invoice
    // must never do.
    const s = buildContractSummary(
      input({
        changeOrders: [
          { number: 1, title: "Agreed", amountCents: 5_000_00, status: "approved" },
          { number: 2, title: "Awaiting answer", amountCents: 8_000_00, status: "pending" },
          { number: 3, title: "Rejected", amountCents: 9_000_00, status: "declined" },
        ],
      })
    )!;
    expect(s.changeOrders).toHaveLength(1);
    expect(s.totalChargesCents).toBe(105_000_00);
    expect(s.pendingCoTotalCents).toBe(8_000_00);
  });

  it("a declined CO is neither charged nor reported as pending", () => {
    const s = buildContractSummary(
      input({
        changeOrders: [{ number: 1, title: "Rejected", amountCents: 9_000_00, status: "declined" }],
      })
    )!;
    expect(s.totalChargesCents).toBe(100_000_00);
    expect(s.pendingCoTotalCents).toBe(0);
  });

  // ── The tax case ───────────────────────────────────────────────────────
  //
  // Charges are pre-tax; a payment arrives tax-inclusive. Subtracting one from
  // the other told the GC they owed LESS than they do, by exactly the tax
  // already collected — on the document their AP department reconciles from.
  it("folds tax already invoiced into the balance on a taxable job", () => {
    const s = buildContractSummary(
      input({
        // $50,000 billed + 8.625% tax = $54,312.50, paid in full.
        invoices: [{ subtotalCents: 50_000_00, totalCents: 54_312_50 }],
        payments: [{ dateIso: "2026-07-01", amountCents: 54_312_50 }],
      })
    )!;
    expect(s.taxBilledToDateCents).toBe(4_312_50);
    // $100,000 contract + $4,312.50 tax − $54,312.50 paid = $50,000 left.
    expect(s.currentBalanceCents).toBe(50_000_00);
  });

  it("prints no tax line on an exempt job, exactly like the sample", () => {
    const s = buildContractSummary(
      input({
        invoices: [{ subtotalCents: 50_000_00, totalCents: 50_000_00 }],
        payments: [{ dateIso: "2026-07-01", amountCents: 50_000_00 }],
      })
    )!;
    expect(s.taxBilledToDateCents).toBe(0);
    expect(s.currentBalanceCents).toBe(50_000_00);
  });

  it("never counts a negative tax, however an invoice was edited", () => {
    const s = buildContractSummary(
      input({ invoices: [{ subtotalCents: 50_000_00, totalCents: 49_000_00 }] })
    )!;
    expect(s.taxBilledToDateCents).toBe(0);
  });

  it("orders payments oldest first, undated ones leading", () => {
    const s = buildContractSummary(
      input({
        payments: [
          { dateIso: "2026-08-01", amountCents: 3_00 },
          { dateIso: null, amountCents: 1_00 },
          { dateIso: "2026-06-15", amountCents: 2_00 },
        ],
      })
    )!;
    expect(s.payments.map((p) => p.amountCents)).toEqual([1_00, 2_00, 3_00]);
    expect(s.paymentsTotalCents).toBe(6_00);
  });

  it("overpayment reads as a credit, not a negative balance", () => {
    const s = buildContractSummary(
      input({ payments: [{ dateIso: "2026-07-01", amountCents: 120_000_00 }] })
    )!;
    expect(s.currentBalanceCents).toBe(-20_000_00);
  });

  it("first invoice on a job: no payment rows, nothing zeroed", () => {
    const s = buildContractSummary(input({ invoices: [{ subtotalCents: 10_000_00, totalCents: 10_000_00 }] }))!;
    expect(s.payments).toEqual([]);
    expect(s.paymentsTotalCents).toBe(0);
    expect(s.currentBalanceCents).toBe(100_000_00);
  });
});
