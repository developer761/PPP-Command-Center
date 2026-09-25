import { describe, it, expect } from "vitest";
import { renderInvoicePdf, type InvoicePdfInput } from "@/lib/commercial/invoices/invoice-pdf";

/** Minimal valid input covering the branches that differ (CO line, deduct line,
 *  paid, tax-exempt vs taxed). A real render that yields %PDF bytes proves the
 *  component tree is valid — the way statement/WO PDFs are only ever proven. */
function baseInput(overrides: Partial<InvoicePdfInput> = {}): InvoicePdfInput {
  return {
    invoiceNumber: "INV-2026-0042",
    issuedAt: "2026-08-14",
    dueAt: "2026-09-13",
    poNumber: "PO-778",
    paymentTerms: "Net 30",
    customerMessage: "Thank you.",
    subtotalCents: 500000,
    taxPct: 8.625,
    taxCents: 43125,
    totalCents: 543125,
    paidCents: 100000,
    balanceCents: 443125,
    taxExemptCertNumber: null,
    isTaxExempt: false,
    accountName: "Acme GC",
    billTo: ["123 Main St", "Central Islip, NY 11722"],
    dealName: "Panera — Holbrook",
    rows: [
      { description: "Base painting scope", quantity: 1, unit: null, unitPriceCents: 480000, amountCents: 480000 },
      { description: "CO-001 — Extra coat", quantity: 1, unit: null, unitPriceCents: 30000, amountCents: 30000, isChangeOrder: true },
      { description: "CO-002 — Deduct unused doors", quantity: 1, unit: null, unitPriceCents: -10000, amountCents: -10000, isChangeOrder: true },
    ],
    company: {
      name: "Tomco Painting",
      legal_name: "Tomco Painting",
      address_line1: "77 Windsor Place, Ste. 13",
      city: "Central Islip",
      state: "NY",
      zip: "11722",
      phone: "631-582-2770",
      email: "info@tomcopainting.com",
      website: "https://www.tomcopainting.com",
    },
    logo: null,
    ...overrides,
  };
}

describe("renderInvoicePdf", () => {
  it("renders a valid PDF for a taxed invoice with CO + deduct lines", async () => {
    const buf = await renderInvoicePdf(baseInput());
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a tax-exempt invoice (cert number path)", async () => {
    const buf = await renderInvoicePdf(
      baseInput({ isTaxExempt: true, taxExemptCertNumber: "EX-99182", taxCents: 0, totalCents: 500000, balanceCents: 400000 })
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no rows / no message / no PO (empty-ish invoice)", async () => {
    const buf = await renderInvoicePdf(
      baseInput({ rows: [], customerMessage: null, poNumber: null, paidCents: 0 })
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders an OVERPAID invoice (negative balance → credit) without breaking", async () => {
    const buf = await renderInvoicePdf(
      baseInput({ paidCents: 600000, balanceCents: -56875 })
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

/**
 * How many PAGES the invoice takes.
 *
 * Every test above asserts the bytes start with "%PDF-", which proves the
 * component tree is valid and nothing else. They would all pass on a
 * five-page invoice for a one-line job — and page count is the defect people
 * actually notice, because this document goes to a GC's accounts-payable desk.
 *
 * Checked after finding the same blind spot on the plan report, where it had
 * quietly grown to two pages and pushed the estimator sign-off onto a sheet of
 * its own.
 */
describe("invoice page count", () => {
  const pages = async (input: InvoicePdfInput) => {
    const { PDFDocument } = await import("pdf-lib");
    const buf = await renderInvoicePdf(input);
    return (await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true })).getPageCount();
  };
  const row = (i: number) => ({
    description: `Line item ${i} — interior repaint, two coats`,
    quantity: 1, unit: null, unitPriceCents: 25_000, amountCents: 25_000,
  });

  it("a short invoice is ONE page", async () => {
    expect(await pages(baseInput({ rows: [row(1)] }))).toBe(1);
  });

  it("an empty invoice is one page, not zero", async () => {
    // A zero-page PDF opens to nothing; it would look like a broken download.
    expect(await pages(baseInput({ rows: [], customerMessage: null, poNumber: null }))).toBe(1);
  });

  it("a typical invoice still fits on one page", async () => {
    expect(await pages(baseInput({ rows: [1, 2, 3].map(row) }))).toBe(1);
  });

  it("a long invoice grows, but stays proportionate", async () => {
    // 20 lines legitimately needs a second sheet. What this guards against is a
    // layout change that suddenly makes it five.
    expect(await pages(baseInput({ rows: Array.from({ length: 20 }, (_, i) => row(i)) }))).toBeLessThanOrEqual(2);
  });

  it("is LETTER, so it prints on US paper without scaling", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const buf = await renderInvoicePdf(baseInput());
    const size = (await PDFDocument.load(new Uint8Array(buf))).getPage(0).getSize();
    expect(Math.round(size.width)).toBe(612);
    expect(Math.round(size.height)).toBe(792);
  });
});

/**
 * A LUMP-SUM INVOICE MUST NOT APOLOGISE FOR ITSELF.
 *
 * Mary sent one in on 2026-09-24: SF-00315403 to J & L Property Investors,
 * $3,208.13, printing "No line items on this invoice." directly above
 * BALANCE DUE on the copy the customer receives.
 *
 * The data was not missing. 88 of the 95 live invoices — $1.98M — came from
 * Salesforce, where a work order carries ONE agreed figure and no line detail,
 * and the importer deliberately stores that subtotal rather than inventing
 * lines for it. So the document was describing a defect that was not there,
 * which is its own defect.
 *
 * react-pdf compresses its content streams, so asserting the WORDS inside the
 * buffer proves nothing either way — a text assertion here would pass whatever
 * the component printed. What a render CAN prove is that the branch produces a
 * valid document rather than throwing, which is what these check.
 */
describe("an invoice with no line items", () => {
  it("renders from a bare subtotal, with a job name", async () => {
    const buf = await renderInvoicePdf(
      baseInput({ rows: [], dealName: "3505 Veterans Memorial Highway-Unit S1" }),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("renders when there is no job name either", async () => {
    // The fallback wording has to hold on its own — an imported invoice whose
    // opportunity never got a name still goes to a GC.
    const buf = await renderInvoicePdf(baseInput({ rows: [], dealName: null }));
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("still renders a lump sum inside the Financial Summary layout", async () => {
    // The contract block changes the surrounding markup; the empty-rows branch
    // sits inside it and must not break the one-page fit.
    const buf = await renderInvoicePdf(
      baseInput({
        rows: [],
        dealName: "Unit S1",
        contract: {
          originalCents: 295000,
          changeOrders: [],
          changeOrderTotalCents: 0,
          totalChargesCents: 295000,
          taxBilledToDateCents: 25813,
          payments: [],
          paymentsTotalCents: 0,
          currentBalanceCents: 320813,
          pendingCoTotalCents: 0,
        },
      }),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
