import { describe, it, expect, vi } from "vitest";

/**
 * The AR statement is the PDF we email a GC. An invoice on a DELETED deal
 * used to print on it as "Deleted deal" and count toward the total we asked
 * them to pay — while the receivables report and AR aging, the internal twins,
 * both dropped it. The statement now applies the same rule.
 *
 * Mocked at the data boundary: the invoice list holds one invoice on a live
 * deal and one on a deal the live-deal list no longer returns.
 */

vi.mock("@/lib/commercial/db", () => ({ commercialDb: () => ({}) }));
vi.mock("@/lib/commercial/invoices/db", () => ({
  listCommercialInvoices: async () => [
    { id: "i-live", invoice_number: "INV-1", opportunity_id: "opp-live", status: "sent", total_cents: 10_000, paid_cents: 0, balance_cents: 10_000, issued_at: "2026-09-01", due_at: "2026-10-01" },
    { id: "i-dead", invoice_number: "INV-2", opportunity_id: "opp-deleted", status: "sent", total_cents: 4_321, paid_cents: 0, balance_cents: 4_321, issued_at: "2026-09-01", due_at: "2026-10-01" },
  ],
}));
vi.mock("@/lib/commercial/opportunities/db", () => ({
  // Live deals under a live account only — opp-deleted is not here.
  listCommercialOpportunities: async () => [{ id: "opp-live", title: "Cipla", deleted_at: null }],
  derivedOppName: (o: { title: string }) => o.title,
}));
vi.mock("@/lib/commercial/aia/db", () => ({ aiaBillingRollupBulk: async () => new Map() }));

describe("the GC's AR statement", () => {
  it("neither prints nor totals an invoice on a deleted deal", async () => {
    const { getOpenInvoiceStatementForAccount } = await import("@/lib/commercial/invoices/statement");
    const s = await getOpenInvoiceStatementForAccount("acct1", Date.parse("2026-10-16T16:00:00Z"));
    expect(s.rows.map((r) => r.invoiceNumber)).toEqual(["INV-1"]);
    expect(s.rows.map((r) => r.dealName)).not.toContain("Deleted deal");
    expect(s.totalOutstandingCents).toBe(10_000);
  });
});
