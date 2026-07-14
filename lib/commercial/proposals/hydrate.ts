/**
 * Phase F.2 helper — hydrate a fresh proposal's header_json + estimator
 * snapshot from the account + deal + estimator record.
 *
 * Snapshot pattern: header + estimator fields freeze at proposal
 * create so the PDF stays stable if the source records are edited
 * later. Editable inline on the editor.
 */

import "server-only";
import { commercialDb } from "@/lib/commercial/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import { listStandardExclusions } from "@/lib/commercial/exclusions/db";
import type {
  ProposalHeaderJson,
  ProposalEstimatorSnapshot,
} from "./db";

export type HydratedProposalContext = {
  opp: CommercialOpportunity;
  header: ProposalHeaderJson;
  estimator: ProposalEstimatorSnapshot;
  standardExclusionIds: string[];
};

/** Pull everything a fresh proposal needs: header block, estimator
 *  sign-off, and the seeded standard-category exclusion ids. */
export async function hydrateProposalContext(
  oppId: string
): Promise<HydratedProposalContext | null> {
  const opp = await getCommercialOpportunity(oppId);
  if (!opp) return null;
  const account = await getCommercialAccount(opp.account_id);

  // Header — snapshotted from account + deal fields at create.
  const gcAddressLines: string[] = [];
  if (account?.billing_street) gcAddressLines.push(account.billing_street);
  const cityLine = [account?.billing_city, account?.billing_state, account?.billing_zip]
    .filter((s): s is string => Boolean(s?.trim()))
    .join(", ");
  if (cityLine) gcAddressLines.push(cityLine);

  const projectName = derivedOppName(opp, account?.company_name ?? null);
  const projectAddress = opp.location_short?.trim() || null;

  const header: ProposalHeaderJson = {
    gc_company: account?.company_name ?? undefined,
    gc_address_lines: gcAddressLines.length > 0 ? gcAddressLines : undefined,
    project_name: projectName || undefined,
    project_address: projectAddress || undefined,
    date_iso: new Date().toISOString().slice(0, 10),
    show_capital_improvement_notice: false,
  };

  // Attention/phone/email — pull the primary contact if set.
  if (opp.primary_contact_id) {
    const sb = commercialDb();
    const { data } = await sb
      .from("commercial_contacts")
      .select("first_name, last_name, email, phone")
      .eq("id", opp.primary_contact_id)
      .maybeSingle();
    const c = data as {
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
    } | null;
    if (c) {
      const name = [c.first_name, c.last_name]
        .filter((s): s is string => Boolean(s?.trim()))
        .join(" ");
      if (name) header.attention = name;
      if (c.email) header.email = c.email;
      if (c.phone) header.phone = c.phone;
    }
  }

  // Estimator sign-off.
  const estimator: ProposalEstimatorSnapshot = {};
  if (opp.estimator_user_id) {
    const sb = commercialDb();
    const { data } = await sb
      .from("profiles")
      .select("sf_user_name, email")
      .eq("user_id", opp.estimator_user_id)
      .maybeSingle();
    const p = data as { sf_user_name: string | null; email: string | null } | null;
    if (p?.sf_user_name) estimator.name = p.sf_user_name;
    if (p?.email) estimator.email = p.email;
  }
  // Fall back to free-text estimator name if no user linked.
  if (!estimator.name && opp.estimator_name) {
    estimator.name = opp.estimator_name;
  }

  // Pre-seed standard exclusions (the 2 canonical Tomco bullets).
  const standardRows = await listStandardExclusions();
  const standardExclusionIds = standardRows.map((r) => r.id);

  return { opp, header, estimator, standardExclusionIds };
}
