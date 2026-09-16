/**
 * The bytes a GC actually receives, rendered and counted.
 *
 * Karan's rule: every customer-facing PDF is ONE page. The download route and
 * the EMAIL route render the same document through different code, and only one
 * of them applies the fit ladder — so this asserts on page count, against a real
 * imported Tomco invoice, rather than on which function the source calls.
 */
import { it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";

const pages = async (bytes: Buffer | Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

it("the invoice a GC is emailed is one page", async () => {
  const { commercialDb } = await import("@/lib/commercial/db");
  const { data } = await commercialDb()
    .from("commercial_invoices")
    .select("id, invoice_number, total_cents")
    .order("total_cents", { ascending: false })
    .limit(1);
  const id = (data as { id: string; invoice_number: string }[])[0];
  const { buildInvoicePdfInput } = await import("@/lib/commercial/invoices/invoice-pdf-data");
  const { renderInvoicePdf } = await import("@/lib/commercial/invoices/invoice-pdf");
  const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
  const input = await buildInvoicePdfInput(id.id);
  if (!input) throw new Error("no pdf input");

  const raw = await renderInvoicePdf(input);
  const fit = await renderFitToOnePage((pageHeightScale) => renderInvoicePdf({ ...input, pageHeightScale }));
  console.log(`  ${id.invoice_number}: unfitted ${await pages(raw)} page(s) · fitted ${await pages(fit.bytes)} page(s)`);
  expect(await pages(fit.bytes)).toBe(1);
  // The real assertion: whatever the email path produces must be one page too.
  const { buildInvoiceEmailPdf } = await import("@/lib/commercial/invoices/email");
  const emailed = await buildInvoiceEmailPdf(id.id);
  if (!emailed) throw new Error("the email path produced no PDF");
  console.log(`  emailed attachment: ${await pages(emailed)} page(s)`);
  expect(await pages(emailed)).toBe(1);
}, 120_000);
