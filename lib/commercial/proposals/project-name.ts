import { derivedOppName } from "@/lib/commercial/opportunities/db";

/**
 * The PROJECT line on a proposal.
 *
 * Stephanie 2026-08-13: *"Proposals autofills the GC/Builders name, not the
 * opportunity/project name. The proposal follows the opportunity."*
 *
 * The old order fell through to `derivedOppName`, which composes
 * "{account} - {client} - {street}" — so PROJECT opened with the builder's
 * name. That is redundant as well as wrong: the builder is already printed
 * directly above it as `gc_company`. PROJECT means the job, so it reads client
 * and address, and the GC appears exactly once on the page.
 *
 * Lives outside `hydrate.ts` (which is `server-only`) so the rule can be
 * tested directly — it decides what a customer sees on every proposal PDF,
 * which is too much to leave uncovered.
 */
export function proposalProjectName(
  opp: {
    title?: string | null;
    title_override?: string | null;
    client_name?: string | null;
    property_street?: string | null;
  },
  accountName: string | null | undefined
): string {
  // 1. Someone typed an explicit name. It always wins, everywhere.
  //    (Katie 2026-07-20, CRITICAL: an earlier order dropped the override when
  //    client_name was set, so "The Big Job at Jones" printed as "Jones
  //    Property".)
  const override = opp.title_override?.trim();
  if (override) return override;

  // 2. The end-customer label on its own — Katie's Tomco JD-Sports convention,
  //    2026-07-20. Deliberately NOT combined with the address: an earlier
  //    version of this fix appended the street here, which quietly changed the
  //    printed name for every deal Katie's rule covers. Stephanie's complaint
  //    was never about these; it was about the fallback below.
  const client = opp.client_name?.trim();
  if (client) return client;

  // 3. No customer label, so name the job by where it is. THIS is Stephanie's
  //    fix: the old fallback went straight to derivedOppName, which composes
  //    "{account} - {client} - {street}" and therefore opened with the
  //    builder — already printed directly above as gc_company.
  const street = opp.property_street?.trim();
  if (street) return street;

  // 4. Last resort, so a bare deal still prints something rather than blank.
  return derivedOppName(
    { title: opp.title ?? "", client_name: opp.client_name ?? null, property_street: opp.property_street, title_override: opp.title_override },
    accountName
  );
}
