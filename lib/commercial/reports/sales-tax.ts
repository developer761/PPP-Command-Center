import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { listCommercialOpportunities, derivedOppName } from "@/lib/commercial/opportunities/db";
import { deriveInvoiceStatus, type InvoiceStatus } from "@/lib/commercial/invoices/constants";
import { resolveTaxExemption } from "@/lib/commercial/tax/exemption";
import { etDateOf } from "@/lib/date-et";

/**
 * SALES TAX — what we charged, and what we didn't charge on whose authority.
 *
 * "Tomco Sales Tax" is one of the thirteen reports in Alex's Salesforce folder.
 * A tax report is only half an accounting document if it lists what was
 * collected: the number a filing needs is the collected total, but the number
 * that costs money is the EXEMPT one, because an exemption you can't produce a
 * certificate for is an assessment waiting to happen. NY capital-improvement
 * exemptions are per-project (Stephanie, 2026-08-13), so the certificate has to
 * be on the record that granted it.
 *
 * So this report has two halves:
 *
 *  1. Collected — per period, per rate, so a filing can be reconciled.
 *  2. Exempt — every invoice billed with no tax, and whether the exemption has
 *     a certificate number behind it. The ones that don't are the report's
 *     whole reason for existing.
 *
 * Tax is `total − subtotal` on the invoice, never recomputed from `tax_pct`. The
 * invoice froze its own rate when it was issued; re-deriving would silently
 * restate history the first time a jurisdiction's rate changed.
 *
 * AIA applications carry no separate tax line — G702/G703 bills contract
 * values — so they are absent by design rather than omitted by accident.
 */

export type SalesTaxRow = {
  invoiceId: string;
  invoiceNumber: string;
  issuedYmd: string;
  accountId: string;
  accountName: string;
  jobName: string;
  /** Pre-tax. The taxable base a filing asks for. */
  subtotalCents: number;
  taxCents: number;
  /** The rate the invoice froze when it was issued. */
  taxPct: number;
  /** True when the invoice carried no tax at all. */
  exempt: boolean;
  /** Where the exemption came from — the job, the account, or nowhere. */
  exemptSource: "opportunity" | "account" | null;
  /** The certificate on file. Null on an exempt invoice = the compliance risk. */
  certNumber: string | null;
  href: string;
};

export type SalesTaxByRate = { taxPct: number; baseCents: number; taxCents: number; count: number };

export type SalesTaxReport = {
  rows: SalesTaxRow[];
  /** Taxable base — pre-tax subtotals of invoices that DID carry tax. */
  taxableBaseCents: number;
  taxCollectedCents: number;
  /** Pre-tax subtotals billed with no tax. */
  exemptBaseCents: number;
  exemptCount: number;
  /** Exempt invoices with NO certificate number anywhere. The audit exposure. */
  uncertifiedCount: number;
  uncertifiedBaseCents: number;
  byRate: SalesTaxByRate[];
  /** Every GC in the unfiltered set, for the picker. */
  gcOptions: { id: string; name: string }[];
  filtered: boolean;
  generatedAt: string;
};

export type SalesTaxFilters = {
  fromYmd?: string;
  toYmd?: string;
  accountId?: string;
  /** Only the exempt invoices with no certificate behind them. */
  uncertifiedOnly?: boolean;
};

/**
 * Group and total. Pure, so the filing figures are testable without a database
 * — a tax total nobody can unit-test is a tax total nobody should file.
 */
export function summarizeSalesTax(
  allRows: SalesTaxRow[],
  filters: SalesTaxFilters = {},
  nowMs = Date.now()
): SalesTaxReport {
  const { fromYmd, toYmd, accountId, uncertifiedOnly } = filters;
  const filtered = !!(fromYmd || toYmd || accountId || uncertifiedOnly);

  const rows = allRows.filter((r) => {
    if (fromYmd && r.issuedYmd < fromYmd) return false;
    if (toYmd && r.issuedYmd > toYmd) return false;
    if (accountId && r.accountId !== accountId) return false
    ;
    if (uncertifiedOnly && !(r.exempt && !r.certNumber)) return false;
    return true;
  });

  const taxed = rows.filter((r) => !r.exempt);
  const exempt = rows.filter((r) => r.exempt);
  const uncertified = exempt.filter((r) => !r.certNumber);

  const rateMap = new Map<number, SalesTaxByRate>();
  for (const r of taxed) {
    const key = Math.round(r.taxPct * 1000) / 1000;
    const cur = rateMap.get(key) ?? { taxPct: key, baseCents: 0, taxCents: 0, count: 0 };
    cur.baseCents += r.subtotalCents;
    cur.taxCents += r.taxCents;
    cur.count += 1;
    rateMap.set(key, cur);
  }

  return {
    // Newest first: a filing is about the period you just closed.
    rows: [...rows].sort((a, b) => b.issuedYmd.localeCompare(a.issuedYmd) || b.taxCents - a.taxCents),
    taxableBaseCents: taxed.reduce((n, r) => n + r.subtotalCents, 0),
    taxCollectedCents: taxed.reduce((n, r) => n + r.taxCents, 0),
    exemptBaseCents: exempt.reduce((n, r) => n + r.subtotalCents, 0),
    exemptCount: exempt.length,
    uncertifiedCount: uncertified.length,
    uncertifiedBaseCents: uncertified.reduce((n, r) => n + r.subtotalCents, 0),
    byRate: [...rateMap.values()].sort((a, b) => b.taxCents - a.taxCents),
    gcOptions: [...new Map(allRows.map((r) => [r.accountId, r.accountName])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    filtered,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export async function getSalesTaxReport(
  filters: SalesTaxFilters = {},
  nowMs = Date.now()
): Promise<SalesTaxReport> {
  const sb = commercialDb();
  const opps = await listCommercialOpportunities({ includeArchived: true });
  const oppById = new Map(opps.map((o) => [o.id, o] as const));

  const acctIds = [...new Set(opps.map((o) => o.account_id))];
  const acctById = new Map<string, { name: string; exempt: boolean | null; cert: string | null }>();
  if (acctIds.length > 0) {
    const { data } = await sb
      .from("commercial_accounts")
      .select("id, company_name, tax_exempt, tax_exempt_cert_number")
      .in("id", acctIds);
    for (const a of (data ?? []) as {
      id: string;
      company_name: string | null;
      tax_exempt: boolean | null;
      tax_exempt_cert_number: string | null;
    }[]) {
      acctById.set(a.id, {
        name: a.company_name ?? "—",
        exempt: a.tax_exempt,
        cert: a.tax_exempt_cert_number,
      });
    }
  }

  const invoices = await paginateAll<{
    id: string;
    invoice_number: string;
    status: InvoiceStatus;
    issued_at: string | null;
    created_at: string;
    due_at: string | null;
    subtotal_cents: number;
    total_cents: number;
    tax_pct: number;
    opportunity_id: string;
    account_id: string;
    balance_cents: number;
    paid_cents: number;
  }>(() =>
    sb
      .from("commercial_invoices")
      .select(
        "id, invoice_number, status, issued_at, created_at, due_at, subtotal_cents, total_cents, tax_pct, opportunity_id, account_id, balance_cents, paid_cents"
      )
      .is("deleted_at", null)
      .order("issued_at", { ascending: false })
      .order("id", { ascending: true })
  );

  const rows: SalesTaxRow[] = [];
  for (const inv of invoices) {
    // A DRAFT has charged nobody anything and a VOID has been withdrawn.
    // Including either would put tax in a filing that was never billed.
    const status = deriveInvoiceStatus(inv);
    if (status === "draft" || status === "void") continue;
    const opp = oppById.get(inv.opportunity_id);
    // An invoice whose deal is gone from the app is gone from the report.
    if (!opp) continue;
    const acct = acctById.get(inv.account_id);
    const issuedYmd = etDateOf(inv.issued_at ?? inv.created_at);
    if (!issuedYmd) continue;

    const taxCents = inv.total_cents - inv.subtotal_cents;
    // EXEMPT is decided by what the invoice actually charged, not by a flag
    // that may have been flipped afterwards. A deal switched to exempt after a
    // taxable invoice went out does not un-charge that tax.
    const exempt = taxCents === 0;
    const resolved = resolveTaxExemption({
      opportunityTaxExempt: opp.tax_exempt ?? null,
      accountTaxExempt: acct?.exempt ?? null,
    });
    const exemptSource = exempt && resolved.exempt ? resolved.source === "opportunity" ? "opportunity" : "account" : null;
    const certNumber = exempt
      ? (exemptSource === "opportunity"
          ? opp.tax_exempt_cert_number ?? acct?.cert ?? null
          : acct?.cert ?? null)
      : null;

    rows.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      issuedYmd,
      accountId: inv.account_id,
      accountName: acct?.name ?? "—",
      jobName: derivedOppName(opp, acct?.name ?? null),
      subtotalCents: inv.subtotal_cents,
      taxCents,
      taxPct: Number(inv.tax_pct) || 0,
      exempt,
      exemptSource,
      certNumber: certNumber?.trim() || null,
      href: `/commercial/invoices/${inv.id}`,
    });
  }

  return summarizeSalesTax(rows, filters, nowMs);
}
