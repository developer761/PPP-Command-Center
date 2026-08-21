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

// ────────────── the four choices a person picks from ──────────────

/**
 * ONE mapping between the picker and the columns.
 *
 * The job's tax setting is now editable from two places — the opportunity's
 * Info panel and the proposal editor (Stephanie 2026-08-20: "Sales tax should
 * be an option on the proposal not just on the opportunity overview"). Two
 * copies of "capital_improvement means tax_exempt=true and no certificate
 * number" is the same shape as the bug the exemption rule above was written to
 * kill: three call sites each deciding taxability their own way.
 */
export type TaxChoice = "inherit" | "exempt" | "capital_improvement" | "taxable";

export type TaxColumns = {
  tax_exempt: boolean | null;
  tax_exempt_reason: "certificate" | "capital_improvement" | null;
  tax_exempt_cert_number: string | null;
};

export function taxChoiceToColumns(
  choice: string,
  certNumberRaw?: string | null
): TaxColumns {
  // Both exempt choices charge no tax; they differ only in WHY. A certificate
  // is the customer's status (ST-119.1); a capital improvement is the nature
  // of the work (ST-124).
  const tax_exempt =
    choice === "exempt" || choice === "capital_improvement"
      ? true
      : choice === "taxable"
        ? false
        : null;
  const tax_exempt_reason =
    choice === "capital_improvement"
      ? ("capital_improvement" as const)
      : choice === "exempt"
        ? ("certificate" as const)
        : null;
  return {
    tax_exempt,
    tax_exempt_reason,
    // A capital improvement has no certificate number — it is evidenced by a
    // signed ST-124 from the customer, not a number we hold. Clearing the
    // override drops a number that no longer applies to anything, rather than
    // leaving it attached to an inherited setting where an invoice could cite
    // it.
    tax_exempt_cert_number:
      tax_exempt_reason === "certificate" ? (certNumberRaw ?? "").trim() || null : null,
  };
}

/** The inverse — which option a stored row should show as selected. */
export function columnsToTaxChoice(input: {
  tax_exempt: boolean | null | undefined;
  tax_exempt_reason?: "certificate" | "capital_improvement" | null;
}): TaxChoice {
  if (input.tax_exempt === true) {
    return input.tax_exempt_reason === "capital_improvement" ? "capital_improvement" : "exempt";
  }
  if (input.tax_exempt === false) return "taxable";
  return "inherit";
}
