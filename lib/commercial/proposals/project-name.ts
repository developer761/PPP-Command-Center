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
  // 1. THE ADDRESS. Brendan 2026-09-03, asked what the customer-facing name
  //    should be instead of the nickname: "I'd say it's should be the the
  //    address."
  //
  //    This reverses the order Katie set on 2026-07-20 (the Tomco "JD Sports"
  //    convention — the end-customer label on its own). Both are defensible and
  //    they only differ when a job has BOTH: Brendan's own example is
  //    "Plainview" at 115 Connetquot Avenue. He is the one sending these and
  //    answering the GC's questions about them, and a GC's own records key on
  //    the site far more often than on the end tenant, so the address wins.
  //    The client name is still right behind it for a job with no address yet.
  const street = opp.property_street?.trim();
  if (street) return street;

  // 2. No address recorded, so name it by the end customer — Katie's
  //    convention, now the fallback rather than the lead. Deliberately NOT
  //    combined with the address: an earlier version appended the street here,
  //    which quietly changed the printed name for every deal her rule covered.
  const client = opp.client_name?.trim();
  if (client) return client;

  // 3. Last resort, so a bare deal still prints something rather than blank.
  //    `title_override: null` on purpose — derivedOppName appends the nickname
  //    since migration 170, which would smuggle it back onto the document by
  //    the back door after the whole point of this function is keeping it off.
  return derivedOppName(
    { title: opp.title ?? "", client_name: opp.client_name ?? null, property_street: opp.property_street, title_override: null },
    accountName
  );
}
