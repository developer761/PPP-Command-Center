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
  // The NICKNAME never appears here.
  //
  // Brendan 2026-09-03: "Let's not use the nickname customer facing. It should
  // always be the most formal name customer facing." His proposal went out
  // titled "Main" — the shorthand the office uses — for a job whose customer is
  // Plainview at 115 Connetquot Avenue. The live nicknames make the point on
  // their own: "Ste A1", "Exterior", "Tomco Office". "Exterior" is a fine thing
  // to call a job across a desk and a poor thing to head a proposal to Ronald
  // McDonald House with.
  //
  // This does NOT overturn Katie 2026-07-20 ("an explicit title_override must
  // win"), because the field she was talking about no longer exists. It was
  // "Custom display name" then — a formal name someone typed. Migration 170
  // turned it into "Project nickname · what the team calls it", appended to the
  // real name rather than replacing it. Her rule was about a name; his is about
  // a nickname. Same column, different meaning.
  //
  // 1. The end-customer label on its own — Katie's Tomco JD-Sports convention,
  //    2026-07-20. Deliberately NOT combined with the address: an earlier
  //    version of this fix appended the street here, which quietly changed the
  //    printed name for every deal Katie's rule covers. Stephanie's complaint
  //    was never about these; it was about the fallback below.
  const client = opp.client_name?.trim();
  if (client) return client;

  // 2. No customer label, so name the job by where it is. THIS is Stephanie's
  //    fix: the old fallback went straight to derivedOppName, which composes
  //    "{account} - {client} - {street}" and therefore opened with the
  //    builder — already printed directly above as gc_company.
  const street = opp.property_street?.trim();
  if (street) return street;

  // 3. Last resort, so a bare deal still prints something rather than blank.
  //    `title_override: null` on purpose — derivedOppName appends the nickname
  //    since migration 170, which would smuggle it back onto the document by
  //    the back door after the whole point of this function is keeping it off.
  return derivedOppName(
    { title: opp.title ?? "", client_name: opp.client_name ?? null, property_street: opp.property_street, title_override: null },
    accountName
  );
}
