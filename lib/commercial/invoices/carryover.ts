import "server-only";

import { isSalesforceCarryoverInvoice } from "./constants";

/**
 * 🔴 THE MIGRATED SALESFORCE INVOICE AND THE AIA CERTIFICATE ARE THE SAME MONEY.
 *
 * When Tomco moved over, `stageInvoices` in scripts/import-tomco.mjs created an
 * `SF-<work order>` invoice carrying each work order's balance. On most jobs
 * that is still the right figure to chase. But once a job's real billing is in
 * the platform as issued G702 applications, the placeholder and the certificates
 * bill the same work — and every surface that adds the two ledgers together
 * counts it twice.
 *
 * NOT A THEORY. Measured on LMJ Cipla, 2026-10-16:
 *
 *   contract                                        $88,627.09
 *   AIA applications 1-5, all paid    billed $87,627.09 · collected $87,627.09
 *   invoice SF-00268177               total  $100,127.09 · paid      $88,577.10
 *   what the deal P&L reported        invoiced $187,754.18 — 212% of contract
 *
 * They are literally the same cheques. Cheque #7696, $49,162.50, 2025-11-04
 * appears on BOTH ledgers with the same reference string; so do 8496, 8589,
 * 8833 and 8922, to the cent and the day. The importer has never heard of AIA
 * (`grep -c commercial_aia scripts/import-tomco.mjs` is 0), so any job Mary
 * bills by G702 here and that also had Salesforce work-order payments gets both
 * ledgers filled.
 *
 * The rule was already written — `isSalesforceCarryoverInvoice` — and applied
 * in exactly two files, `reports/receivables.ts` and `reports/ar-aging.ts`,
 * both INTERNAL. The statement we email a GC read $372,962.39 while the list we
 * chase read $361,412.40: we were asking a customer for $11,549.99 they had
 * already paid, and the document that leaves the building was the higher one.
 *
 * So the rule lives here now, once, with the set-builder beside it, because a
 * guard that each surface re-implements is a guard half the surfaces will miss.
 * That is how it got missed eight times.
 */

/** Deals whose billing is in the platform as issued AIA applications. */
export async function dealsBilledViaAia(opportunityIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(opportunityIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const { aiaBillingRollupBulk } = await import("@/lib/commercial/aia/db");
  // `aiaBillingRollupBulk` returns an entry only for deals with an ISSUED
  // application, which is exactly the condition: a draft certificate has billed
  // nothing, so the carry-over is still the only bill on that job.
  return new Set((await aiaBillingRollupBulk(ids)).keys());
}

/**
 * Is this invoice the same money as the deal's AIA certificates?
 *
 * Pass the set from `dealsBilledViaAia`. Returns false for every ordinary
 * invoice and for every `SF-` invoice on a job that has no issued certificate —
 * those balances are real and several match the office's hand-kept AR sheet to
 * the cent.
 */
export function isSupersededByAia(
  inv: { invoice_number?: string | null; opportunity_id?: string | null },
  billedViaAia: ReadonlySet<string>
): boolean {
  return (
    isSalesforceCarryoverInvoice(inv) &&
    !!inv.opportunity_id &&
    billedViaAia.has(inv.opportunity_id)
  );
}

/** The same rule as a filter, for the many callers that hold a plain list. */
export function withoutCarryoverDuplicates<
  T extends { invoice_number?: string | null; opportunity_id?: string | null },
>(invoices: T[], billedViaAia: ReadonlySet<string>): T[] {
  if (billedViaAia.size === 0) return invoices;
  return invoices.filter((i) => !isSupersededByAia(i, billedViaAia));
}

export { isSalesforceCarryoverInvoice };
