import "server-only";

/**
 * Load everything `proposalTaxLine` needs for one proposal.
 *
 * Split from the pure math so the math stays testable without a database, and
 * so BOTH render paths — the download route and the send-to-GC path in db.ts —
 * compute tax the same way. Two callers each doing their own lookup is how the
 * emailed PDF and the downloaded PDF end up disagreeing about the number.
 */

import { commercialDb } from "@/lib/commercial/db";
import { listTaxJurisdictions } from "@/lib/commercial/tax/db";
import { resolveTaxExemption } from "@/lib/commercial/tax/exemption";
import { proposalTaxLine, type ProposalTaxLine } from "./proposal-tax";

export async function loadProposalTaxLine(input: {
  opportunityId: string | null | undefined;
  priceCents: number;
}): Promise<ProposalTaxLine | null> {
  if (!input.opportunityId) return null;
  const sb = commercialDb();

  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("property_zip, tax_exempt, account_id")
    .eq("id", input.opportunityId)
    .maybeSingle<{ property_zip: string | null; tax_exempt: boolean | null; account_id: string | null }>();
  if (!opp) return null;

  // The account is the fallback half of the exemption rule — a job with no
  // override inherits it. Skipping this lookup would tax an exempt customer.
  let accountTaxExempt: boolean | null = null;
  if (opp.account_id) {
    const { data: acct } = await sb
      .from("commercial_accounts")
      .select("tax_exempt")
      .eq("id", opp.account_id)
      .maybeSingle<{ tax_exempt: boolean | null }>();
    accountTaxExempt = acct?.tax_exempt ?? null;
  }

  const { exempt } = resolveTaxExemption({
    opportunityTaxExempt: opp.tax_exempt,
    accountTaxExempt,
  });

  return proposalTaxLine({
    priceCents: input.priceCents,
    zip: opp.property_zip,
    exempt,
    jurisdictions: await listTaxJurisdictions({ activeOnly: true }),
  });
}
