import "server-only";

import { getCommercialInvoice, listInvoiceLineItems } from "./db";
import { listMilestonesForInvoice } from "./milestones";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer } from "@/lib/commercial/operating-company/assets";
import { resolveTaxExemption } from "@/lib/commercial/tax/exemption";
import { listChangeOrders } from "@/lib/commercial/change-orders/db";
import { listCommercialInvoices } from "./db";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { listInvoicePayments } from "./db";
import { formatOpportunityNumber } from "@/lib/commercial/opportunities/db";
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

  const [lineItems, milestones, account, opp, company, logo, jobChangeOrders, jobInvoices, contractBase] =
    await Promise.all([
      listInvoiceLineItems(invoiceId),
      listMilestonesForInvoice(invoiceId),
      getCommercialAccount(inv.account_id),
      getCommercialOpportunity(inv.opportunity_id),
      getOperatingCompany(),
      getBrandLogoBuffer().catch(() => null),
      // JOB-level, for the Financial Summary — see the `contract` field doc.
      listChangeOrders(inv.opportunity_id).catch(() => []),
      listCommercialInvoices({ opportunityId: inv.opportunity_id }).catch(() => []),
      getEffectiveContractBaseCents(inv.opportunity_id).catch(() => 0),
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

  // ── Financial Summary (Brendan's format) ───────────────────────────────
  //
  // Reconciles the WHOLE JOB: original contract + approved change orders, less
  // everything paid so far. The invoice's own amount is then stated against it.
  //
  // APPROVED change orders only. A pending CO is money the GC has not agreed
  // to, and putting it in "Total Customer Charges" would bill them for it. It
  // is surfaced separately as still-to-bill. (Same trap the CO register has.)
  const approvedCos = jobChangeOrders.filter((c) => c.status === "approved");
  const changeOrderTotalCents = approvedCos.reduce((n, c) => n + c.amount_cents, 0);
  const originalCents = contractBase > 0 ? contractBase : 0;

  // Payments across every LIVE, non-void invoice on the job.
  const billableJobInvoices = jobInvoices.filter(
    (i) => i.status !== "void" && i.status !== "draft"
  );
  const paymentLists = await Promise.all(
    billableJobInvoices.map((i) => listInvoicePayments(i.id).catch(() => []))
  );
  const payments = paymentLists
    .flat()
    .map((pm) => ({ dateIso: pm.paid_at ?? null, amountCents: pm.amount_cents }))
    .sort((a, b) => String(a.dateIso ?? "").localeCompare(String(b.dateIso ?? "")));
  const paymentsTotalCents = payments.reduce((n, pm) => n + pm.amountCents, 0);

  // Sales tax actually BILLED on this job so far.
  //
  // Without this the summary reconciles two different bases against each other:
  // the charge side is the contract sum and its change orders, which are
  // pre-tax, while the credit side is payments, which settle
  // `total_cents = subtotal + ROUND(subtotal * tax_pct / 100)`
  // (migration 042) and therefore carry tax. On a taxable job every payment
  // wrote off more than it should have, so Current Balance came out light by
  // exactly the tax collected — and once the job was fully billed and paid the
  // figure went negative and the PDF printed "Credit Balance" at the GC's AP
  // department on an invoice that was settled to the cent.
  //
  // Tax is only owed as work is billed, so this is the tax on invoices actually
  // issued — not a rate applied to the whole contract. Fully billed and fully
  // paid then lands exactly on zero; a tax-exempt job contributes nothing and
  // the summary reads as it always did.
  const salesTaxBilledCents = billableJobInvoices.reduce(
    (n, i) => n + (Number(i.total_cents) - Number(i.subtotal_cents)),
    0
  );

  const { totalChargesCents, currentBalanceCents } = reconcileJobCharges({
    originalCents,
    changeOrderTotalCents,
    salesTaxBilledCents,
    paymentsTotalCents,
  });

  // Change orders the GC hasn't answered yet — stated on the invoice as a note
  // so the contract doesn't look smaller than the job actually is.
  const pendingCoTotalCents = jobChangeOrders
    .filter((c) => c.status === "pending")
    .reduce((n, c) => n + c.amount_cents, 0);

  // Only render the summary when there is a contract to reconcile against.
  // Building it on a zero would print "Original Contract Total $0.00" above a
  // real invoice, which reads as a data error rather than as "no bid on file".
  const contract =
    originalCents > 0
      ? {
          originalCents,
          changeOrders: approvedCos.map((c) => ({
            number: c.co_number,
            title: c.title,
            amountCents: c.amount_cents,
          })),
          changeOrderTotalCents,
          salesTaxBilledCents,
          totalChargesCents,
          payments,
          paymentsTotalCents,
          currentBalanceCents,
          pendingCoTotalCents,
        }
      : null;

  const projectAddress =
    [opp.property_street, [opp.property_city, opp.property_state].filter(Boolean).join(", ")]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join(", ") || null;

  return {
    contract,
    jobNumber: opp.deal_number ?? formatOpportunityNumber(opp.project_number) ?? null,
    projectAddress,
    billingContact: null,
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

/**
 * The Financial Summary's arithmetic, as a pure function so the invariant that
 * matters can actually be asserted: a job that is fully billed and fully paid
 * reconciles to exactly zero.
 *
 * Both sides must be on the same basis. Charges are the pre-tax contract plus
 * approved change orders plus the tax billed to date; payments settle
 * tax-inclusive invoice totals. Mixing the two understates the balance by the
 * tax collected and eventually prints a phantom "Credit Balance".
 */
export function reconcileJobCharges(input: {
  originalCents: number;
  changeOrderTotalCents: number;
  salesTaxBilledCents: number;
  paymentsTotalCents: number;
}): { totalChargesCents: number; currentBalanceCents: number } {
  const totalChargesCents =
    input.originalCents + input.changeOrderTotalCents + input.salesTaxBilledCents;
  return { totalChargesCents, currentBalanceCents: totalChargesCents - input.paymentsTotalCents };
}
