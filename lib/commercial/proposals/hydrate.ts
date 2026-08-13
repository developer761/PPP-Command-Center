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

  // Katie 2026-07-20 audit fix (CRITICAL): title_override MUST win here
  // so a user's explicit "Custom display name" on the deal edit sheet
  // also drives the proposal PDF's PROJECT field. Prior order silently
  // dropped the override when client_name was set — a user who typed
  // "The Big Job at Jones" saw "Jones Property" on the PDF instead.
  //
  // Priority:
  //   1. opp.title_override — user's explicit custom name (wins everywhere)
  //   2. opp.client_name    — Tomco JD-Sports convention (end-customer label)
  //   3. derivedOppName     — computed {account} - {client} - {street}
  const projectName =
    opp.title_override?.trim() ||
    opp.client_name?.trim() ||
    derivedOppName(opp, account?.company_name ?? null);
  const siteAddressParts = [
    opp.property_street?.trim(),
    [opp.property_city?.trim(), opp.property_state?.trim()]
      .filter(Boolean)
      .join(", "),
  ].filter(Boolean);
  // Karan 2026-07-20 (Phase G Q2): property_street is canonical after
  // migration 066 backfill. location_short reader removed with the sweep.
  const projectAddress = siteAddressParts.length > 0 ? siteAddressParts.join(", ") : null;

  const header: ProposalHeaderJson = {
    gc_company: account?.company_name ?? undefined,
    gc_address_lines: gcAddressLines.length > 0 ? gcAddressLines : undefined,
    project_name: projectName || undefined,
    project_address: projectAddress || undefined,
    // ET calendar date (not UTC) so an evening proposal doesn't stamp tomorrow.
    date_iso: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    show_capital_improvement_notice: false,
    // Migration 065 (Phase G Q1): snapshot the deal number ("ALT-0125")
    // into header_json.proposal_number so the PDF LogoBlock renders
    // "No. ALT-0125" under the date — matches Tomco's letterhead
    // convention from the JD Sports reference PDF.
    proposal_number: opp.deal_number ?? undefined,
  };

  // Attention/phone/email — pull the primary contact if set. commercial_contacts
  // stores a single `full_name` (NOT first_name/last_name — selecting those 400s
  // and PostgREST returns null, which silently blanked the whole block).
  if (opp.primary_contact_id) {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_contacts")
      .select("full_name, email, phone")
      .eq("id", opp.primary_contact_id)
      .maybeSingle();
    if (error) {
      console.warn("[proposals/hydrate] contact lookup failed:", error.message);
    }
    const c = data as {
      full_name: string | null;
      email: string | null;
      phone: string | null;
    } | null;
    if (c) {
      if (c.full_name?.trim()) header.attention = c.full_name.trim();
      if (c.email) header.email = c.email;
      if (c.phone) header.phone = c.phone;
    }
  }

  // Estimator sign-off.
  // Katie 2026-08-13: "Estimator Sign-off — IF an Estimator is added to the
  // Opportunity team, this should pull automatically from that contact."
  //
  // It only ever read `estimator_user_id`, the single Estimator field on the
  // deal. A job where the estimator was added to the TEAM instead — which is
  // where Brendan's four roles live, and the more natural place to put one —
  // printed a proposal with a blank sign-off.
  //
  // Order is explicit-first: the Estimator FIELD wins when set, because
  // somebody chose it for this deal; the team assignment is the fallback; the
  // free-text name is last.
  const sb = commercialDb();
  const estimator: ProposalEstimatorSnapshot = {};
  let estimatorUserId = opp.estimator_user_id ?? null;
  if (!estimatorUserId) {
    const { data: assigned } = await sb
      .from("commercial_opportunity_assignments")
      .select("user_id, is_primary")
      .eq("opportunity_id", opp.id)
      .eq("role", "estimator")
      // The primary one first, so a job with two estimators signs with the
      // person marked as THE estimator rather than whoever was added first.
      .order("is_primary", { ascending: false })
      .limit(1);
    estimatorUserId = (assigned?.[0] as { user_id: string } | undefined)?.user_id ?? null;
  }
  if (estimatorUserId) {
    const { data } = await sb
      .from("profiles")
      .select("full_name, sf_user_name, email")
      .eq("user_id", estimatorUserId)
      .maybeSingle();
    const p = data as { full_name: string | null; sf_user_name: string | null; email: string | null } | null;
    // `full_name` first: a provisioned user (an admin-created login, which is
    // how Kim exists) has no Salesforce mapping, so reading only sf_user_name
    // left their name blank on the signed proposal.
    if (p?.full_name || p?.sf_user_name) estimator.name = (p.full_name || p.sf_user_name) as string;
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
