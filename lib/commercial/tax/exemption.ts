/**
 * Is this job taxable?
 *
 * Stephanie 2026-08-13: *"tax exemption follows opportunity not account."*
 * In New York an exemption certificate is issued for a PROJECT — the same GC
 * can be exempt on a municipal job and taxable on the private one next door.
 *
 * One function, because the answer was already being computed in three
 * separate places (two in invoices/db.ts, one in change-orders/db.ts) and the
 * comment in the first of them says why that hurt: the change-order path
 * "computed tax from the ZIP alone and auto-created drafts charging an exempt
 * GC sales tax". Adding a per-job override to three copies would have been
 * the same bug waiting again, so the rule lives here and they all call it.
 *
 * The override is deliberately three-state:
 *
 *   null   → inherit the account (today's behaviour)
 *   true   → exempt for this job whatever the account says
 *   false  → taxable for this job even though the account is exempt
 *
 * `false` is a real answer, not an absence — which is exactly why the
 * opportunity column is nullable and why this reads `== null` rather than
 * testing falsiness. Treating `false` as "unset" would make it impossible to
 * bill a taxable job for an otherwise-exempt customer.
 */

export type TaxExemptSource = "opportunity" | "account" | "default";

export type TaxExemptionInput = {
  /** The job's own override. Undefined/null means "inherit". */
  opportunityTaxExempt?: boolean | null;
  accountTaxExempt?: boolean | null;
};

export type TaxExemption = {
  exempt: boolean;
  /** Which record decided it — surfaced in the UI so nobody has to guess. */
  source: TaxExemptSource;
};

export function resolveTaxExemption(input: TaxExemptionInput): TaxExemption {
  if (input.opportunityTaxExempt != null) {
    return { exempt: input.opportunityTaxExempt, source: "opportunity" };
  }
  if (input.accountTaxExempt != null) {
    return { exempt: input.accountTaxExempt, source: "account" };
  }
  // Neither set: charge tax. Under-charging tax is money Tomco pays itself;
  // over-charging is a credit note. Neither is great, but a missing record
  // should not silently make a job exempt.
  return { exempt: false, source: "default" };
}

/** Convenience for the call sites that only need the boolean. */
export function isTaxExempt(input: TaxExemptionInput): boolean {
  return resolveTaxExemption(input).exempt;
}

/** Plain-English note for the invoice / change-order UI. */
export function taxExemptionNote(r: TaxExemption): string {
  if (!r.exempt) {
    return r.source === "opportunity"
      ? "Taxable — set on this job, overriding the customer's exemption."
      : "Taxable.";
  }
  return r.source === "opportunity"
    ? "Tax exempt — set on this job."
    : "Tax exempt — from the customer record.";
}
