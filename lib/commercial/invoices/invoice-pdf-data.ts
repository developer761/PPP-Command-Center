import "server-only";

import { getCommercialInvoice, listInvoiceLineItems } from "./db";
import { listMilestonesForInvoice } from "./milestones";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer } from "@/lib/commercial/operating-company/assets";
import { resolveTaxExemption } from "@/lib/commercial/tax/exemption";
import type { InvoicePdfInput, InvoicePdfRow } from "./invoice-pdf";

/**
 * Assemble everything the branded invoice PDF needs from an invoice id — one
 * place, used by BOTH the download route and the email-send so the on-file copy
 * and the emailed copy are byte-identical. Returns null if the invoice (or its
 * parent deal) is gone.
 *
 * An invoice bills EITHER by flat line items OR by milestones; this flattens
 * whichever it has into the PDF's `rows`. Tax exemption follows the JOB (NY
 * certificates are per-project — Stephanie 2026-08-13), so the cert number comes
 * from the source the exemption actually resolves to.
 */
export async function buildInvoicePdfInput(invoiceId: string): Promise<InvoicePdfInput | null> {
  const inv = await getCommercialInvoice(invoiceId);
  if (!inv) return null;

  const [lineItems, milestones, account, opp, company, logo] = await Promise.all([
    listInvoiceLineItems(invoiceId),
    listMilestonesForInvoice(invoiceId),
    getCommercialAccount(inv.account_id),
    getCommercialOpportunity(inv.opportunity_id),
    getOperatingCompany(),
    getBrandLogoBuffer().catch(() => null),
  ]);

  // The docblock above promised this and it was never implemented. Both loaders
  // hard-filter `deleted_at`, so a soft-deleted account or deal came back null
  // and the PDF quietly degraded to `Bill to: Customer` with no address and no
  // project line — then the Email-to-GC panel, which doesn't check either,
  // shipped that document on Tomco letterhead. Refuse to build it instead.
  if (!account || !opp) return null;

  // Rows — line items win; fall back to milestones for a milestone invoice.
  let rows: InvoicePdfRow[];
  if (lineItems.length > 0) {
    rows = lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unitPriceCents: li.unit_price_cents,
      amountCents: li.subtotal_cents,
      isChangeOrder: !!(li as { change_order_id?: string | null }).change_order_id,
    }));
  } else {
    rows = milestones.map((m) => ({
      description: m.name,
      quantity: 1,
      unit: null,
      unitPriceCents: m.amount_cents,
      amountCents: m.amount_cents,
      isChangeOrder: !!(m as { change_order_id?: string | null }).change_order_id,
    }));
  }

  // Bill-to address lines from the account (skip empties).
  const billTo: string[] = [];
  const street = [account?.billing_street, account?.billing_street2].map((s) => s?.trim()).filter(Boolean) as string[];
  billTo.push(...street);
  const cityLine = [
    [account?.billing_city?.trim(), account?.billing_state?.trim()].filter(Boolean).join(", "),
    account?.billing_zip?.trim(),
  ]
    .filter(Boolean)
    .join(" ");
  if (cityLine) billTo.push(cityLine);

  // Tax exemption follows the JOB; the cert number comes from whichever record
  // (opp or account) actually grants it.
  const exemption = resolveTaxExemption({
    opportunityTaxExempt: opp?.tax_exempt ?? null,
    accountTaxExempt: account?.tax_exempt ?? null,
  });
  const certNumber = exemption.exempt
    ? exemption.source === "opportunity"
      ? opp?.tax_exempt_cert_number ?? account?.tax_exempt_cert_number ?? null
      : account?.tax_exempt_cert_number ?? null
    : null;

  return {
    isVoid: inv.status === "void",
    invoiceNumber: inv.invoice_number,
    issuedAt: inv.issued_at ?? inv.created_at ?? null,
    dueAt: inv.due_at,
    poNumber: inv.po_number,
    paymentTerms: inv.payment_terms,
    customerMessage: inv.customer_message,
    subtotalCents: inv.subtotal_cents,
    taxPct: inv.tax_pct,
    taxCents: inv.total_cents - inv.subtotal_cents,
    totalCents: inv.total_cents,
    paidCents: inv.paid_cents,
    balanceCents: inv.balance_cents,
    taxExemptCertNumber: certNumber,
    isTaxExempt: exemption.exempt,
    accountName: account?.company_name ?? "Customer",
    billTo,
    dealName: opp ? derivedOppName(opp, account?.company_name ?? null) : null,
    rows,
    company: {
      name: company.name,
      legal_name: company.legal_name,
      address_line1: company.address_line1,
      address_line2: company.address_line2,
      city: company.city,
      state: company.state,
      zip: company.zip,
      phone: company.phone,
      email: company.email,
      website: company.website,
    },
    logo,
  };
}
