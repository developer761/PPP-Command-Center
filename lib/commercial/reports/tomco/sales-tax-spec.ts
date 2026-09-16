import type { ReportSpec } from "@/lib/commercial/reports/grouped/spec";
import type { SalesTaxRow } from "@/lib/commercial/reports/sales-tax";

/**
 * "Tomco Sales Tax" — Mary's, and she files from it.
 *
 * Grouped by the RATE the invoice froze when it was issued, which is how a
 * filing is prepared: one line per rate, the taxable base under it, the tax
 * collected on it. Her screenshot is a single 8.7500% group over four invoices,
 * $24,763.74 of base and $2,166.84 of tax.
 *
 * The report module itself already exists (lib/commercial/reports/sales-tax.ts)
 * and is what the Accounting page uses — this is the same numbers in the shape
 * Mary reads, not a second calculation of the tax.
 */
export const SALES_TAX_SPEC: ReportSpec<SalesTaxRow> = {
  title: "Sales Tax",
  sourceLabel: "Opportunities with Work Orders",
  blurb: "Every issued invoice by the tax rate it carried — the taxable base and the tax collected, ready to file.",
  totals: [
    { label: "Total taxable subtotal", value: (rows) => rows.reduce((n, r) => n + r.subtotalCents, 0) },
    { label: "Total tax", value: (rows) => rows.reduce((n, r) => n + r.taxCents, 0) },
  ],
  groupings: [
    [{ key: "rate", label: "Tax rate", of: (r) => (r.taxPct > 0 ? `${r.taxPct.toFixed(4)}%` : "No tax") }],
    [{ key: "gc", label: "GC", of: (r) => r.accountName }],
    [{ key: "month", label: "Month", of: (r) => r.issuedYmd.slice(0, 7) }],
  ],
  columns: [
    { key: "job", label: "Opportunity name", text: (r) => r.jobName, href: (r) => r.href },
    { key: "invoice", label: "Invoice", text: (r) => r.invoiceNumber, secondary: true },
    { key: "issued", label: "Issued", text: (r) => r.issuedYmd, secondary: true },
    { key: "subtotal", label: "Quoted subtotal", kind: "money", amount: (r) => r.subtotalCents },
    { key: "tax", label: "Tax", kind: "money", amount: (r) => r.taxCents },
  ],
};

/** The rows a filing is made from: anything that actually carried tax. */
export const taxedRows = (rows: SalesTaxRow[]) =>
  rows.filter((r) => r.taxCents > 0).sort((a, b) => b.issuedYmd.localeCompare(a.issuedYmd));
