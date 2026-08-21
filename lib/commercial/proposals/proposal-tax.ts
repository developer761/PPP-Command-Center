/**
 * Sales tax ON THE PROPOSAL.
 *
 * Stephanie 2026-08-20: *"Sales Tax isn't carrying over to proposal, it needs
 * to show on the proposal"* — with the exact shape she wants:
 *
 *     Price: $500.00
 *     NYS Sales Tax: $43.75
 *     TOTAL: $543.75
 *
 * It genuinely was not there: the proposal had no tax concept at all. Tax was
 * computed for the first time at INVOICE, from the job's ZIP. So a GC agreed a
 * number, and the first invoice was 8.625% bigger than the thing they signed.
 *
 * The rate resolution is the SAME `resolveTaxForZip` the invoice uses, against
 * the same jurisdictions table, on the same ZIP — deliberately, because the
 * whole point is that the proposal and the invoice cannot disagree. If this
 * file ever grew its own rate lookup, the two documents would drift and the
 * drift would be found by a customer.
 *
 * Returns null when NO tax line should print — exempt job, capital
 * improvement, or a ZIP that matches no jurisdiction. Null is not "zero": a
 * proposal that prints "NYS Sales Tax: $0.00" on an exempt job invites the
 * question of why it is listed at all.
 */

import {
  resolveTaxForZip,
  thouToPct,
  type TaxJurisdictionLite,
} from "@/lib/commercial/tax/constants";

export type ProposalTaxLine = {
  /** The pre-tax number — what the proposal called TOTAL before. */
  priceCents: number;
  /** e.g. "NYS Sales Tax (8.625%)". */
  label: string;
  taxCents: number;
  /** priceCents + taxCents — what the customer actually owes. */
  totalCents: number;
  jurisdictionName: string;
  rateThou: number;
};

export type ProposalTaxInput = {
  /** The proposal's TOTAL as stored — always the pre-tax figure. */
  priceCents: number;
  /** Site ZIP for the job. */
  zip: string | null | undefined;
  /** Resolved by lib/commercial/tax/exemption — the one authority. */
  exempt: boolean;
  jurisdictions: ReadonlyArray<TaxJurisdictionLite>;
};

/**
 * Tax is charged on the base scope only.
 *
 * Alternates are deliberately excluded from `priceCents` upstream (the rollup
 * sums `is_alternate = false`), so an alternate the customer has not accepted
 * cannot be taxed. When they accept one it becomes a change order, which runs
 * the same exemption rule through its own path.
 */
export function proposalTaxLine(input: ProposalTaxInput): ProposalTaxLine | null {
  if (input.exempt) return null;
  if (!Number.isFinite(input.priceCents) || input.priceCents <= 0) return null;
  const hit = resolveTaxForZip(input.zip, input.jurisdictions);
  if (!hit) return null;
  const rateThou = hit.rateThou;
  if (!Number.isFinite(rateThou) || rateThou <= 0) return null;
  // Rates are thousandths of a PERCENT: 8.625% is 8625, so the divisor is
  // 100 (percent) x 1000 (thousandths). Rounded once, at the end, to the cent.
  const taxCents = Math.round((input.priceCents * rateThou) / 100_000);
  const pct = thouToPct(rateThou);
  return {
    priceCents: input.priceCents,
    // Trailing zeros trimmed — "8.625%" and "8.5%", never "8.500%".
    label: `NYS Sales Tax (${pct.toFixed(3).replace(/\.?0+$/, "")}%)`,
    taxCents,
    totalCents: input.priceCents + taxCents,
    jurisdictionName: hit.jurisdiction.name,
    rateThou,
  };
}
