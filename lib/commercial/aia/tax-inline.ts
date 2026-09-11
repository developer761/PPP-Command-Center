import "server-only";

/**
 * Sales tax lives INSIDE the contract price, not on a line of its own.
 *
 * Stephanie 2026-09-11: "Sales tax can't show as a separate line item. It has
 * to all be one contract price."
 *
 * This reverses a decision I made on 2026-09-01 and documented as deliberate.
 * The reasoning then was that a tax-exemption certificate can arrive mid-job,
 * and folding tax into the contract meant removing it would restate the
 * Original Contract Sum — telling the GC the contract changed when it had not.
 * That reasoning still holds; Stephanie is the one who sends these to GCs and
 * has decided the separate line is the worse problem. Her call. The
 * consequence is recorded in `aia-sales-tax.test.ts` so it is not rediscovered
 * as a bug.
 *
 * TWO RULES, both about not charging a GC twice:
 *
 * 1. An application uses EITHER the legacy `TAX` row OR inline tax, never
 *    both. `hasLegacyTaxRow` is the switch. One live application already has a
 *    tax row with $437.50 billed against it — that is history on a certificate
 *    the GC may be holding, so it keeps its row and is never folded.
 *
 * 2. Every folded value is DERIVED from an authoritative pre-tax base — the
 *    application's `original_contract_cents`, or a change order's
 *    `amount_cents` — never from the line's own current value. That is what
 *    makes it idempotent: running the fold twice cannot compound, which
 *    matters because users can edit a scheduled value by hand and the
 *    reconcile runs again on every change-order approval.
 */

/** Tax on one pre-tax base, via the resolver the proposal and invoice share. */
export async function taxOnCents(opts: {
  opportunityId: string;
  baseCents: number;
}): Promise<number> {
  if (!Number.isFinite(opts.baseCents) || opts.baseCents <= 0) return 0;
  const { loadProposalTaxLine } = await import(
    "@/lib/commercial/proposals/proposal-tax-load"
  );
  const line = await loadProposalTaxLine({
    opportunityId: opts.opportunityId,
    priceCents: opts.baseCents,
  });
  return line ? Math.round(line.taxCents) : 0;
}

/**
 * A pre-tax base plus its tax — the single number that goes on the line.
 *
 * Rounding happens once, here, on the tax portion. Rounding the inclusive
 * total instead drifts against the proposal's own tax line, and a GC's AP
 * system rejects a certificate that disagrees with the contract by a cent.
 */
export async function taxInclusiveCents(opts: {
  opportunityId: string;
  baseCents: number;
}): Promise<number> {
  const base = Math.round(opts.baseCents);
  if (!Number.isFinite(base) || base <= 0) return Math.max(0, base || 0);
  return base + (await taxOnCents({ opportunityId: opts.opportunityId, baseCents: base }));
}

/** Does this application still carry the old separate TAX row? */
export function hasLegacyTaxRow(lines: Array<{ item_no?: string | null }>): boolean {
  return lines.some((l) => (l.item_no ?? "").trim().toUpperCase() === "TAX");
}
